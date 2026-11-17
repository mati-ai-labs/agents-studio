import crypto, { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  companies,
  companyConnectors,
  createDb,
  issueComments,
  issues,
  slackPolls,
  slackThreadBindings,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const heartbeatMocks = vi.hoisted(() => ({ wakeup: vi.fn(async () => null) }));
const slackMocks = vi.hoisted(() => ({
  postSlackMessage: vi.fn(async () => ({ channelId: "C1", messageTs: "1712345678.000100" })),
  updateSlackMessage: vi.fn(async () => ({ channelId: "C1", ts: "1712345678.000100" })),
  getSlackUserName: vi.fn(async (_db: unknown, _companyId: string, userId: string) => ({ U01SAK: "Saksham Jain", U02PUN: "Puneet Sharma" } as Record<string, string>)[userId] ?? null),
}));
vi.mock("../services/heartbeat.js", () => ({ heartbeatService: () => heartbeatMocks }));
vi.mock("../services/slack.js", async () => {
  const actual = await vi.importActual<typeof import("../services/slack.js")>("../services/slack.js");
  return { ...actual, ...slackMocks };
});

import {
  buildSlackPollBlocks,
  closeSlackPoll,
  createSlackPoll,
  getSlackPoll,
  recordSlackPollVote,
  summarizeSlackPoll,
} from "../services/slack-polls.js";
import { slackInteractionsRoute } from "../routes/slack-interactions.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

const channel = { id: "C1", name: "eng", isPrivate: false, isMember: true, isArchived: false };

describeEmbeddedPostgres("Slack polls", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-slack-polls-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.execute(sql.raw(`
      TRUNCATE TABLE "slack_polls", "slack_thread_bindings", "issue_comments", "issues", "agents",
        "company_connectors", "companies", "activity_log"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(issueStatus = "in_progress") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Poll Co",
      status: "active",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyConnectors).values({
      companyId,
      type: "slack",
      status: "connected",
      config: { teamId: "T1", teamName: "Team", botUserId: "UBOT", scope: "chat:write,channels:history" },
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CEO",
      role: "ceo",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Pick a launch date", status: issueStatus, assigneeAgentId: agentId, identifier: "LCH-1" });
    return { companyId, agentId, issueId };
  }

  async function makePoll(ctx: { companyId: string; agentId: string; issueId: string }, extra: Partial<Parameters<typeof createSlackPoll>[1]> = {}) {
    const { poll } = await createSlackPoll(db, {
      companyId: ctx.companyId,
      issue: { id: ctx.issueId, identifier: "LCH-1" },
      agentId: ctx.agentId,
      agentName: "CEO",
      channel,
      question: "Which day do we launch?",
      options: ["Monday", "Wednesday", "Friday"],
      multiSelect: false,
      threadTs: null,
      mentionUserIds: ["U01SAK"],
      closesAt: null,
      ...extra,
    });
    return poll;
  }

  it("posts the poll as buttons, stores it, and binds its thread to the issue", async () => {
    const ctx = await seed();
    const poll = await makePoll(ctx);
    expect(poll).toMatchObject({ messageTs: "1712345678.000100", status: "open", channelId: "C1" });
    const posted = slackMocks.postSlackMessage.mock.calls[0]![2] as { blocks: Array<Record<string, any>> };
    const buttons = posted.blocks.filter((block) => block.accessory?.type === "button");
    expect(buttons.map((block) => block.accessory.value)).toEqual([`${poll.id}:1`, `${poll.id}:2`, `${poll.id}:3`]);
    expect(posted.blocks[0]!.text.text).toContain("<@U01SAK>");
    expect(await db.select().from(slackThreadBindings)).toEqual([expect.objectContaining({ issueId: ctx.issueId, threadTs: "1712345678.000100" })]);
  });

  it("removes the poll row when Slack refuses the post", async () => {
    const ctx = await seed();
    slackMocks.postSlackMessage.mockRejectedValueOnce(new Error("not_in_channel"));
    await expect(makePoll(ctx)).rejects.toThrow("not_in_channel");
    expect(await db.select().from(slackPolls)).toHaveLength(0);
  });

  it("single-select: a vote moves, a second click takes it back, and each vote comes back to the issue", async () => {
    const ctx = await seed();
    const poll = await makePoll(ctx);
    const vote = (optionId: string, user = "U01SAK") =>
      recordSlackPollVote(db, { pollId: poll.id, optionId, slackUserId: user, channelId: "C1", messageTs: "1712345678.000100" });

    expect(await vote("1")).toMatchObject({ status: "recorded", chosen: ["1"] });
    expect(await vote("2")).toMatchObject({ status: "recorded", chosen: ["2"] });
    await vote("2", "U02PUN");
    let stored = (await getSlackPoll(db, ctx.companyId, poll.id))!;
    expect(summarizeSlackPoll(stored).options.map((option) => option.votes)).toEqual([0, 2, 0]);

    expect(await vote("2")).toMatchObject({ status: "recorded", chosen: [] });
    stored = (await getSlackPoll(db, ctx.companyId, poll.id))!;
    expect(stored.votes).toEqual({ U02PUN: ["2"] });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, ctx.issueId));
    expect(comments).toHaveLength(4);
    expect(comments[0]!.body).toContain("From Slack user Saksham Jain (poll vote):");
    expect(comments[0]!.body).toContain("Voted **Monday**");
    expect(comments.at(-1)!.body).toContain("Took back their vote");
    expect(heartbeatMocks.wakeup).toHaveBeenCalledTimes(4);
    expect(heartbeatMocks.wakeup).toHaveBeenCalledWith(ctx.agentId, expect.objectContaining({ reason: "issue_commented" }));
    expect(slackMocks.updateSlackMessage).toHaveBeenCalledTimes(4);
  });

  it("multi-select keeps several choices per person", async () => {
    const ctx = await seed();
    const poll = await makePoll(ctx, { multiSelect: true });
    await recordSlackPollVote(db, { pollId: poll.id, optionId: "1", slackUserId: "U01SAK", channelId: "C1", messageTs: null });
    const result = await recordSlackPollVote(db, { pollId: poll.id, optionId: "3", slackUserId: "U01SAK", channelId: "C1", messageTs: null });
    expect(result).toMatchObject({ chosen: ["1", "3"] });
  });

  it("ignores clicks from another message, unknown options, and missing polls", async () => {
    const ctx = await seed();
    const poll = await makePoll(ctx);
    expect(await recordSlackPollVote(db, { pollId: poll.id, optionId: "1", slackUserId: "U01SAK", channelId: "C9", messageTs: null })).toEqual({ status: "message_mismatch" });
    expect(await recordSlackPollVote(db, { pollId: poll.id, optionId: "7", slackUserId: "U01SAK", channelId: "C1", messageTs: null })).toEqual({ status: "unknown_option" });
    expect(await recordSlackPollVote(db, { pollId: randomUUID(), optionId: "1", slackUserId: "U01SAK", channelId: "C1", messageTs: null })).toEqual({ status: "not_found" });
  });

  it("closing removes the buttons, records the result on the issue, and refuses further votes", async () => {
    const ctx = await seed();
    const poll = await makePoll(ctx);
    await recordSlackPollVote(db, { pollId: poll.id, optionId: "3", slackUserId: "U02PUN", channelId: "C1", messageTs: null });
    vi.clearAllMocks();

    const closed = (await closeSlackPoll(db, poll.id, { reason: "agent", closedByAgentId: ctx.agentId }))!;
    expect(closed.status).toBe("closed");
    const redraw = slackMocks.updateSlackMessage.mock.calls[0]![2] as { blocks: Array<Record<string, any>> };
    expect(redraw.blocks.some((block) => block.accessory)).toBe(false);
    expect(heartbeatMocks.wakeup).not.toHaveBeenCalled();
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, ctx.issueId));
    expect(comments.at(-1)!.body).toContain("Slack poll closed");
    expect(comments.at(-1)!.body).toContain("**Friday**: 1 (Puneet Sharma)");

    expect(await recordSlackPollVote(db, { pollId: poll.id, optionId: "1", slackUserId: "U01SAK", channelId: "C1", messageTs: null })).toMatchObject({ status: "closed" });
  });

  it("a poll past its deadline closes itself and wakes the agent with the result", async () => {
    const ctx = await seed();
    const poll = await makePoll(ctx, { closesAt: new Date(Date.now() + 60_000) });
    await db.update(slackPolls).set({ closesAt: new Date(Date.now() - 1_000) }).where(eq(slackPolls.id, poll.id));
    vi.clearAllMocks();

    const read = (await getSlackPoll(db, ctx.companyId, poll.id))!;
    expect(read.status).toBe("closed");
    expect(heartbeatMocks.wakeup).toHaveBeenCalledWith(ctx.agentId, expect.objectContaining({ reason: "issue_commented" }));
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, ctx.issueId));
    expect(comments.at(-1)!.body).toContain("(time ran out)");
  });

  it("a vote on a done issue reopens it", async () => {
    const ctx = await seed("done");
    const poll = await makePoll(ctx);
    await recordSlackPollVote(db, { pollId: poll.id, optionId: "1", slackUserId: "U01SAK", channelId: "C1", messageTs: null });
    const [issue] = await db.select().from(issues).where(eq(issues.id, ctx.issueId));
    expect(issue!.status).toBe("todo");
    expect(heartbeatMocks.wakeup).toHaveBeenCalledWith(ctx.agentId, expect.objectContaining({ reason: "issue_reopened_via_slack" }));
  });

  describe("interactivity endpoint", () => {
    const secret = "test-signing-secret";

    function signedPost(server: express.Express, body: string, secretOverride = secret) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = `v0=${crypto.createHmac("sha256", secretOverride).update(`v0:${timestamp}:${body}`).digest("hex")}`;
      return request(server)
        .post("/api/connectors/slack/interactions")
        .set("content-type", "application/x-www-form-urlencoded")
        .set("x-slack-request-timestamp", timestamp)
        .set("x-slack-signature", signature)
        .send(body);
    }

    function server() {
      const app = express();
      app.use("/api/connectors/slack", slackInteractionsRoute(db));
      return app;
    }

    it("records a signed button click and rejects unsigned ones", async () => {
      process.env.SLACK_SIGNING_SECRET = secret;
      const ctx = await seed();
      const poll = await makePoll(ctx);
      const payload = {
        type: "block_actions",
        user: { id: "U01SAK" },
        container: { channel_id: "C1", message_ts: "1712345678.000100" },
        actions: [{ action_id: "paperclip_poll_vote:2", value: `${poll.id}:2` }],
      };
      const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;

      expect((await signedPost(server(), body, "wrong-secret")).status).toBe(401);
      expect((await signedPost(server(), body)).status).toBe(200);
      await vi.waitFor(async () => {
        const stored = (await getSlackPoll(db, ctx.companyId, poll.id))!;
        expect(stored.votes).toEqual({ U01SAK: ["2"] });
      });
    });
  });
});

describe("buildSlackPollBlocks", () => {
  it("shows voters under each option and a closed footer without buttons", () => {
    const poll = {
      id: "p1",
      status: "closed",
      question: "Ship <today>?",
      multiSelect: false,
      options: [{ id: "1", label: "Yes" }, { id: "2", label: "No" }],
      votes: { U1: ["1"], U2: ["1"] },
      closesAt: null,
    } as never;
    const blocks = buildSlackPollBlocks(poll);
    expect(blocks[0]!.text).toMatchObject({ text: ":bar_chart: *Ship &lt;today&gt;?*" });
    expect((blocks[1]!.text as { text: string }).text).toContain("*2* votes: <@U1> <@U2>");
    expect(blocks.some((block) => "accessory" in block)).toBe(false);
    expect(JSON.stringify(blocks.at(-1))).toContain("Poll closed. 2 people voted.");
  });
});
