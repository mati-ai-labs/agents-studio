import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  agents,
  companies,
  companyConnectors,
  createDb,
  issueComments,
  issues,
  slackEventDeliveries,
  slackOutboundDeliveries,
  slackThreadBindings,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const heartbeatMocks = vi.hoisted(() => ({
  wakeup: vi.fn(async () => null),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));
vi.mock("../services/heartbeat.js", () => ({ heartbeatService: () => heartbeatMocks }));
vi.mock("../services/slack.js", async () => {
  const actual = await vi.importActual<typeof import("../services/slack.js")>("../services/slack.js");
  return { ...actual, getSlackUserName: vi.fn(async () => "Asha Rao") };
});

import { bindAgentSlackThread } from "../services/slack-agent-messaging.js";
import { slackInboundHandler } from "../services/slack-inbound-handler.js";
import { issueService } from "../services/issues.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

const channel = { id: "C1", name: "eng", isPrivate: false, isMember: true, isArchived: false };

describeEmbeddedPostgres("agent Slack posts: thread replies come back to the issue", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-slack-agent-post-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.execute(sql.raw(`
      TRUNCATE TABLE "slack_outbound_deliveries", "slack_event_deliveries", "slack_thread_bindings",
        "issue_comments", "issues", "agents", "company_connectors", "companies", "activity_log"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Slack Co",
      status: "active",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const [connector] = await db.insert(companyConnectors).values({
      companyId,
      type: "slack",
      status: "connected",
      config: { teamId: "T1", teamName: "Team", botUserId: "UBOT", scope: "chat:write,channels:history" },
    }).returning();
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CTO",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Need a decision",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    return { companyId, connectorId: connector!.id, agentId, issueId };
  }

  async function deliverReply(threadTs: string, ts: string, text: string) {
    const eventId = `Ev-${ts}`;
    const [delivery] = await db.insert(slackEventDeliveries).values({
      eventId,
      workspaceId: "T1",
      eventType: "message.channels",
      payload: { eventType: "message.channels", eventId, workspaceId: "T1", userId: "U01ASHA", text, channelId: "C1", ts, threadTs },
    }).returning();
    await slackInboundHandler(db).process(delivery!);
    return db.select().from(slackEventDeliveries).where(sql`${slackEventDeliveries.id} = ${delivery!.id}`).then((rows) => rows[0]!);
  }

  it("binds the posted message's thread and turns a reply into an issue comment that wakes the assignee", async () => {
    const { companyId, connectorId, agentId, issueId } = await seed();

    const result = await bindAgentSlackThread(db, { companyId, issueId, channel, threadTs: "1700000000.000100" });
    expect(result).toMatchObject({ status: "bound", issueId });
    const [binding] = await db.select().from(slackThreadBindings);
    expect(binding).toMatchObject({ companyId, connectorId, issueId, workspaceId: "T1", channelId: "C1", threadTs: "1700000000.000100", source: "agent_post" });

    const delivery = await deliverReply("1700000000.000100", "1700000001.000200", "Yes, ship it.");
    expect(delivery).toMatchObject({ status: "succeeded", issueId });

    const comments = await db.select().from(issueComments);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ issueId, externalSource: "slack", externalAuthorId: "U01ASHA" });
    expect(comments[0]!.body).toBe("From Slack user Asha Rao:\nYes, ship it.");
    expect(heartbeatMocks.wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({ reason: "issue_commented" }));
  });

  it("lets one issue own several agent-post threads, and is idempotent per thread", async () => {
    const { companyId, issueId } = await seed();
    expect(await bindAgentSlackThread(db, { companyId, issueId, channel, threadTs: "1700000000.000100" })).toMatchObject({ status: "bound" });
    expect(await bindAgentSlackThread(db, { companyId, issueId, channel, threadTs: "1700000000.000900" })).toMatchObject({ status: "bound" });
    expect(await bindAgentSlackThread(db, { companyId, issueId, channel, threadTs: "1700000000.000900" })).toMatchObject({ status: "already_bound" });
    expect(await db.select().from(slackThreadBindings)).toHaveLength(2);

    await deliverReply("1700000000.000900", "1700000002.000100", "second thread reply");
    expect(await db.select().from(issueComments)).toHaveLength(1);
  });

  it("does not steal a thread that already belongs to another issue", async () => {
    const { companyId, issueId } = await seed();
    const otherIssueId = randomUUID();
    await db.insert(issues).values({ id: otherIssueId, companyId, title: "Other", status: "todo" });
    await bindAgentSlackThread(db, { companyId, issueId: otherIssueId, channel, threadTs: "1700000000.000100" });
    expect(await bindAgentSlackThread(db, { companyId, issueId, channel, threadTs: "1700000000.000100" }))
      .toEqual({ status: "bound_to_other_issue", issueId: otherIssueId });
  });

  it("does not mirror agent comments into agent-post threads (only into the thread an issue came from)", async () => {
    const { companyId, connectorId, agentId, issueId } = await seed();
    await bindAgentSlackThread(db, { companyId, issueId, channel, threadTs: "1700000000.000100" });

    await issueService(db).addComment(issueId, "Working on it", { agentId });
    expect(await db.select().from(slackOutboundDeliveries)).toHaveLength(0);

    // An origin (slack_mention) thread on the same issue still gets progress.
    await db.insert(slackThreadBindings).values({
      companyId, connectorId, issueId, workspaceId: "T1", channelId: "C1", channelName: "eng",
      threadTs: "1600000000.000100", rootEventId: "Ev-root", source: "slack_mention",
    });
    await issueService(db).addComment(issueId, "Progress update", { agentId });
    const outbound = await db.select().from(slackOutboundDeliveries);
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({ threadTs: "1600000000.000100", kind: "progress" });
  });

  it("never throws when Slack is not connected", async () => {
    const { companyId, issueId } = await seed();
    await db.delete(companyConnectors);
    expect(await bindAgentSlackThread(db, { companyId, issueId, channel, threadTs: "1700000000.000100" }))
      .toMatchObject({ status: "skipped" });
  });
});
