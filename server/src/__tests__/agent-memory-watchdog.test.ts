import { describe, expect, it } from "vitest";
import { attributeMemoryToRuns, protectedPidChain, type ProcInfo } from "../services/agent-memory-watchdog.js";

describe("agent memory watchdog attribution", () => {
  // pm2(10) -> server(100, env run "pm2-fake") -> claude(200, run A) -> python(201, no env) ; claude(300, run B)
  const procs: ProcInfo[] = [
    { pid: 10, ppid: 1, rssMb: 50, runId: null },
    { pid: 100, ppid: 10, rssMb: 600, runId: "pm2-fake" },
    { pid: 150, ppid: 100, rssMb: 140, runId: "pm2-fake" },
    { pid: 200, ppid: 100, rssMb: 300, runId: "run-a" },
    { pid: 201, ppid: 200, rssMb: 5800, runId: null },
    { pid: 300, ppid: 100, rssMb: 200, runId: "run-b" },
  ];
  const running = new Set(["run-a", "run-b"]);

  it("sums each running run's processes, including children without the env var", () => {
    const usage = attributeMemoryToRuns(procs, running, protectedPidChain(procs, 100));
    const a = usage.find((u) => u.runId === "run-a")!;
    expect(a.rssMb).toBe(6100);
    expect(a.pids.sort()).toEqual([200, 201]);
    expect(usage.find((u) => u.runId === "run-b")!.rssMb).toBe(200);
  });

  it("never attributes the server, its ancestors, or ids that are not running runs", () => {
    const usage = attributeMemoryToRuns(procs, new Set(["pm2-fake", "run-a"]), protectedPidChain(procs, 100));
    const pids = usage.flatMap((u) => u.pids);
    expect(pids).not.toContain(100);
    expect(pids).not.toContain(10);
    expect(usage.find((u) => u.runId === "run-b")).toBeUndefined();
  });
});
