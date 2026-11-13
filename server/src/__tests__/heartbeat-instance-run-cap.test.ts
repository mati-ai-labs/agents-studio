import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";

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

  afterEach(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
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
    expect(slots).toEqual({ maxConcurrentAgentRuns: 1, running: 1, queued: 2, available: 0 });
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
});
