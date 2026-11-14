import { existsSync, readdirSync, readFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { heartbeatService } from "./heartbeat.js";
import { instanceSettingsService } from "./instance-settings.js";
import { issueService } from "./issues.js";
import { logger } from "../middleware/logger.js";

/**
 * Per-run memory cap.
 *
 * The memory gate stops NEW runs from starting while memory is low, but it
 * cannot stop one running agent from growing — on prod a single agent's
 * `claude` process reached 6 GB, the kernel OOM-killed it, and (with the pm2
 * service's OOMPolicy=stop) took Paperclip down with it.
 *
 * Every few seconds this sums the resident memory of each running run's
 * processes — the agent CLI and everything it started (python, tsc, test
 * runners...) — and stops a run that goes over the cap: its processes are
 * killed, the run is cancelled with `memory_limit_exceeded`, and the issue gets
 * a comment telling the agent why, so the next run works in smaller steps.
 *
 * Processes are attributed to a run by `PAPERCLIP_RUN_ID` in their environment
 * (both the CLI and ACP engines set it, and children inherit it) or by having
 * such a process as an ancestor. Only ids of runs that are `running` in the
 * database count: pm2 gives the server itself a PAPERCLIP_RUN_ID that is not
 * a run, and this process and its ancestors are never touched.
 */

export interface ProcInfo {
  pid: number;
  ppid: number;
  rssMb: number;
  runId: string | null;
}

/** Linux only; returns [] where /proc is missing (macOS dev). */
export function readProcessTable(procRoot = "/proc"): ProcInfo[] {
  if (!existsSync(procRoot)) return [];
  const out: ProcInfo[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const status = readFileSync(`${procRoot}/${entry}/status`, "utf8");
      const ppid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? 0);
      const rssKb = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0);
      let runId: string | null = null;
      try {
        const environ = readFileSync(`${procRoot}/${entry}/environ`, "utf8");
        const match = /(?:^|\0)PAPERCLIP_RUN_ID=([^\0]+)/.exec(environ);
        runId = match?.[1] ?? null;
      } catch {
        // Another user's process: not ours to attribute.
      }
      out.push({ pid, ppid, rssMb: rssKb / 1024, runId });
    } catch {
      // Process exited while we were reading it.
    }
  }
  return out;
}

export interface RunMemoryUsage {
  runId: string;
  rssMb: number;
  pids: number[];
}

/**
 * Sum memory per running run. A process belongs to a run when its own
 * PAPERCLIP_RUN_ID, or the nearest ancestor's, is one of `runningRunIds`.
 * `protectedPids` (this server and its ancestors) are never included.
 */
export function attributeMemoryToRuns(
  processes: ProcInfo[],
  runningRunIds: Set<string>,
  protectedPids: Set<number>,
): RunMemoryUsage[] {
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const resolved = new Map<number, string | null>();
  const resolve = (pid: number, depth = 0): string | null => {
    if (resolved.has(pid)) return resolved.get(pid)!;
    const proc = byPid.get(pid);
    let runId: string | null = null;
    if (proc && !protectedPids.has(pid) && depth < 64) {
      if (proc.runId && runningRunIds.has(proc.runId)) runId = proc.runId;
      else if (proc.ppid && proc.ppid !== pid) runId = resolve(proc.ppid, depth + 1);
    }
    resolved.set(pid, runId);
    return runId;
  };
  const usage = new Map<string, RunMemoryUsage>();
  for (const proc of processes) {
    const runId = resolve(proc.pid);
    if (!runId) continue;
    const entry = usage.get(runId) ?? { runId, rssMb: 0, pids: [] };
    entry.rssMb += proc.rssMb;
    entry.pids.push(proc.pid);
    usage.set(runId, entry);
  }
  return [...usage.values()];
}

/** This process and its ancestors (never killed). */
export function protectedPidChain(processes: ProcInfo[], selfPid = process.pid): Set<number> {
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const chain = new Set<number>([selfPid, 1]);
  let current = byPid.get(selfPid);
  for (let depth = 0; current && depth < 64; depth += 1) {
    chain.add(current.ppid);
    current = byPid.get(current.ppid);
  }
  return chain;
}

export interface WatchdogDeps {
  readProcesses?: () => ProcInfo[];
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  selfPid?: number;
}

export function agentMemoryWatchdog(db: Db, deps: WatchdogDeps = {}) {
  const heartbeat = heartbeatService(db);
  const settings = instanceSettingsService(db);
  const readProcesses = deps.readProcesses ?? (() => readProcessTable());
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  let ticking = false;

  /** One pass. Returns the runs it stopped. */
  async function tick(): Promise<RunMemoryUsage[]> {
    if (ticking) return [];
    ticking = true;
    try {
      const limitMb = (await settings.getGeneral()).maxAgentRunMemoryMb ?? 0;
      if (!limitMb || limitMb <= 0) return [];
      const running = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.status, "running"));
      if (running.length === 0) return [];
      const processes = readProcesses();
      if (processes.length === 0) return [];
      const usage = attributeMemoryToRuns(
        processes,
        new Set(running.map((row) => row.id)),
        protectedPidChain(processes, deps.selfPid ?? process.pid),
      );
      const over = usage.filter((entry) => entry.rssMb > limitMb);
      for (const entry of over) {
        await stopRun(entry, limitMb);
      }
      return over;
    } catch (error) {
      logger.warn({ err: error }, "agent memory watchdog tick failed");
      return [];
    } finally {
      ticking = false;
    }
  }

  async function stopRun(entry: RunMemoryUsage, limitMb: number) {
    const usedMb = Math.round(entry.rssMb);
    logger.warn(
      { runId: entry.runId, usedMb, limitMb, pids: entry.pids },
      "agent run exceeded its memory cap; stopping it",
    );
    // Free the memory first, children before parents.
    for (const pid of [...entry.pids].reverse()) {
      try {
        kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    const runRow = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, [entry.runId]))
      .then((rows) => rows[0] ?? null);
    const message = `Run stopped: its processes used ${usedMb} MB of memory, over the ${limitMb} MB per-run cap.`;
    try {
      await heartbeat.cancelRun(entry.runId, message, {
        errorCode: "memory_limit_exceeded",
        resultJson: { memoryLimitExceeded: true, usedMb, limitMb },
        eventMessage: message,
        eventPayload: { usedMb, limitMb, pids: entry.pids },
      });
    } catch (error) {
      logger.warn({ err: error, runId: entry.runId }, "failed to cancel run after memory cap");
    }
    const snapshot = (runRow?.contextSnapshot ?? {}) as Record<string, unknown>;
    const issueId = typeof snapshot.issueId === "string" ? snapshot.issueId : typeof snapshot.taskId === "string" ? snapshot.taskId : null;
    if (issueId) {
      await issueService(db)
        .addComment(
          issueId,
          `${message}\n\nTo stay under the cap: work in smaller steps — read files and logs in slices (e.g. \`tail -c\`, \`head\`), process data in batches, avoid loading whole logs or large datasets into memory, and don't run several heavy commands (builds, type checks, test suites) at once.`,
          {},
          { authorType: "system" },
        )
        .catch((error) => logger.warn({ err: error, runId: entry.runId }, "failed to comment after memory cap"));
    }
  }

  return { tick };
}

/** Start the periodic watchdog (Linux only). Returns a stop function. */
export function startAgentMemoryWatchdog(db: Db, options: { intervalMs?: number } = {}): () => void {
  if (!existsSync("/proc")) return () => {};
  const watchdog = agentMemoryWatchdog(db);
  const timer = setInterval(() => {
    void watchdog.tick();
  }, options.intervalMs ?? 10_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
