import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { clearProviderQuotaCache } from "../services/provider-quota-gate.ts";
import { setHostMemoryReaderForTests } from "../services/memory-gate.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres instance run cap tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat instance-wide run cap", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let previousAgentJwtSecret: string | undefined;

  beforeAll(async () => {
    previousAgentJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "heartbeat-instance-run-cap-test-secret";
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-instance-run-cap-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  // Plenty of memory by default, so only the cap / quota under test binds,
  // whatever the machine running the tests has free.
  beforeEach(() => {
    setHostMemoryReaderForTests(async () => ({ availableMb: 1_000_000, totalMb: 1_000_000 }));
  });

  afterEach(async () => {
    // Cancelled claude_local executions (last tests) can sit in CLI setup for a
    // long time after the run row is final; don't block cleanup on them.
    await Promise.race([
      heartbeatService(db).drainActiveRunExecutions(),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    clearProviderQuotaCache();
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "activity_log",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "agents",
        "companies",
        "instance_settings"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    setHostMemoryReaderForTests(null);
    await tempDb?.cleanup();
    if (previousAgentJwtSecret === undefined) {
      delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    } else {
      process.env.PAPERCLIP_AGENT_JWT_SECRET = previousAgentJwtSecret;
    }
  });

  async function seed(agentCount: number, queuedPerAgent: number, sleepMs: number) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Cap Co",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentIds: string[] = [];
    for (let i = 0; i < agentCount; i += 1) {
      const agentId = randomUUID();
      agentIds.push(agentId);
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: `Agent ${i}`,
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: ["-e", `setTimeout(() => process.exit(0), ${sleepMs})`],
        },
        // Per-agent cap well above the instance cap so only the instance cap binds.
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 10 } },
        permissions: {},
      });
      for (let j = 0; j < queuedPerAgent; j += 1) {
        await db.insert(heartbeatRuns).values({
          id: randomUUID(),
          companyId,
          agentId,
          invocationSource: "on_demand",
          status: "queued",
          responsibleUserId: "board-user",
        });
      }
    }
    return { companyId, agentIds };
  }

  async function statusCounts() {
    const rows = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
    return counts;
  }

  it("leaves runs queued when the instance cap is already used up", async () => {
    await instanceSettingsService(db).updateGeneral({ maxConcurrentAgentRuns: 1 });
    const { companyId, agentIds } = await seed(2, 1, 50);
    // Someone else's run already holds the only slot.
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: agentIds[0]!,
      invocationSource: "on_demand",
      status: "running",
    });

    await heartbeatService(db).resumeQueuedRuns();

    expect(await statusCounts()).toEqual({ running: 1, queued: 2 });
    const slots = await heartbeatService(db).getGlobalRunSlotStatus();
    expect(slots).toMatchObject({ maxConcurrentAgentRuns: 1, running: 1, queued: 2, available: 0 });
  });

  it("never runs more than the cap in parallel, even across concurrent schedulers, and drains the queue", async () => {
    await instanceSettingsService(db).updateGeneral({ maxConcurrentAgentRuns: 2 });
    await seed(3, 2, 600);

    // Three separate service instances race, as routes and the timer do in prod.
    const sweeps = Promise.all([
      heartbeatService(db).resumeQueuedRuns(),
      heartbeatService(db).resumeQueuedRuns(),
      heartbeatService(db).resumeQueuedRuns(),
    ]);

    let maxRunning = 0;
    const deadline = Date.now() + 30_000;
    let counts = await statusCounts();
    while (Date.now() < deadline) {
      counts = await statusCounts();
      maxRunning = Math.max(maxRunning, counts.running ?? 0);
      if ((counts.queued ?? 0) === 0 && (counts.running ?? 0) === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await sweeps;

    expect(maxRunning).toBe(2);
    expect(counts.queued ?? 0).toBe(0);
    expect(counts.running ?? 0).toBe(0);
    // Every run reached a terminal state (the cap only gates start, not outcome).
    expect((counts.succeeded ?? 0) + (counts.failed ?? 0)).toBe(6);
  }, 45_000);

  // A started claude_local run launches the CLI (slow / environment dependent).
  // These tests only care whether the scheduler claimed the run, so cancel it.
  async function cancelStartedClaudeRuns(heartbeat: ReturnType<typeof heartbeatService>, agentId: string) {
    const rows = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns);
    for (const row of rows) {
      if (row.agentId === agentId && row.status === "running") await heartbeat.cancelRun(row.id, "test cleanup");
    }
  }

  function stubMinimax(fivePct: number, status: 1 | 2) {
    vi.stubEnv("CLAUDE_CONFIG_DIR", mkdtempSync(path.join(os.tmpdir(), "quota-gate-claude-")));
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://api.minimax.io/anthropic");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "sk-cp-test");
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("/v1/token_plan/remains")) return realFetch(input, init);
      calls.push(url);
      const now = Date.now();
      return new Response(JSON.stringify({
        model_remains: [{
          model_name: "general",
          end_time: now + 60 * 60_000,
          current_interval_status: status,
          current_interval_remaining_percent: fivePct,
          weekly_end_time: now + 7 * 24 * 60 * 60_000,
          current_weekly_status: 1,
          current_weekly_remaining_percent: 100,
        }],
        base_resp: { status_code: 0, status_msg: "success" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    return calls;
  }

  it("holds Claude Code runs while the MiniMax plan is used up, without holding other adapters", async () => {
    const calls = stubMinimax(0, 2);
    const { companyId } = await seed(1, 1, 50); // process adapter agent, 1 queued run
    const claudeAgentId = randomUUID();
    await db.insert(agents).values({
      id: claudeAgentId,
      companyId,
      name: "Claude Agent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      // Never launch the real Claude CLI in tests; fail fast once started.
      adapterConfig: { command: "/usr/bin/false" },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 10 } },
      permissions: {},
    });
    const claudeRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: claudeRunId,
      companyId,
      agentId: claudeAgentId,
      invocationSource: "on_demand",
      status: "queued",
      responsibleUserId: "board-user",
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const rows = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status }).from(heartbeatRuns);
    expect(rows.find((r) => r.id === claudeRunId)?.status).toBe("queued");
    expect(rows.filter((r) => r.id !== claudeRunId).map((r) => r.status)).not.toContain("queued");
    expect(calls.length).toBeGreaterThan(0);

    const status = await heartbeat.getGlobalRunSlotStatus();
    expect(status.providerQuota).toMatchObject({
      enabled: true,
      reservePercent: 5,
      provider: "minimax",
      holding: true,
      error: null,
      reason: "5-hour window 0% left (exhausted)",
    });

    // Quota comes back: the held run starts on the next sweep.
    vi.unstubAllGlobals();
    clearProviderQuotaCache();
    stubMinimax(80, 1);
    await heartbeat.resumeQueuedRuns();
    const after = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status }).from(heartbeatRuns);
    expect(after.find((r) => r.id === claudeRunId)?.status).not.toBe("queued");
    await cancelStartedClaudeRuns(heartbeat, claudeAgentId);
  }, 45_000);

  it("does not hold runs when the gate is turned off", async () => {
    stubMinimax(0, 2);
    await instanceSettingsService(db).updateGeneral({ providerQuotaGateEnabled: false });
    const { companyId } = await seed(0, 0, 50);
    const claudeAgentId = randomUUID();
    await db.insert(agents).values({
      id: claudeAgentId,
      companyId,
      name: "Claude Agent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      // Never launch the real Claude CLI in tests; fail fast once started.
      adapterConfig: { command: "/usr/bin/false" },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 10 } },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: claudeAgentId,
      invocationSource: "on_demand",
      status: "queued",
      responsibleUserId: "board-user",
    });
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    const rows = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
    expect(rows.map((r) => r.status)).not.toContain("queued");
    await cancelStartedClaudeRuns(heartbeat, claudeAgentId);
  }, 45_000);

  it("holds queued runs while host memory is below the floor, and starts them once it frees up", async () => {
    await instanceSettingsService(db).updateGeneral({ maxConcurrentAgentRuns: 10, minFreeMemoryMb: 1536 });
    await seed(2, 1, 50);
    // 100 MB above the floor: not enough room for even one more run.
    setHostMemoryReaderForTests(async () => ({ availableMb: 1636, totalMb: 7775 }));
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();

    expect(await statusCounts()).toEqual({ queued: 2 });
    const status = await heartbeat.getGlobalRunSlotStatus();
    expect(status.memory).toEqual({
      enabled: true,
      minFreeMemoryMb: 1536,
      availableMb: 1636,
      totalMb: 7775,
      holding: true,
    });

    setHostMemoryReaderForTests(async () => ({ availableMb: 1_000_000, totalMb: 1_000_000 }));
    await heartbeat.resumeQueuedRuns();
    const deadline = Date.now() + 15_000;
    let counts = await statusCounts();
    while (Date.now() < deadline && (counts.queued ?? 0) > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      counts = await statusCounts();
    }
    expect(counts.queued ?? 0).toBe(0);
  }, 30_000);

  it("does not hold runs on memory when the floor is 0", async () => {
    await instanceSettingsService(db).updateGeneral({ maxConcurrentAgentRuns: 10, minFreeMemoryMb: 0 });
    await seed(1, 1, 50);
    setHostMemoryReaderForTests(async () => ({ availableMb: 10, totalMb: 7775 }));
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();

    expect((await statusCounts()).queued ?? 0).toBe(0);
    expect((await heartbeat.getGlobalRunSlotStatus()).memory).toMatchObject({ enabled: false, holding: false });
  }, 30_000);
});
