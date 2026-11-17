import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const slackMocks = vi.hoisted(() => ({
  listSlackChannels: vi.fn(),
  listSlackMembers: vi.fn(),
  listSlackChannelMessages: vi.fn(),
  listSlackThreadMessages: vi.fn(),
  getSlackMessage: vi.fn(),
  updateSlackMessage: vi.fn(),
  deleteSlackMessage: vi.fn(),
  setSlackReaction: vi.fn(),
  joinSlackChannel: vi.fn(),
}));
const activityMocks = vi.hoisted(() => ({ logActivity: vi.fn() }));

vi.mock("../services/slack.js", async () => {
  const actual = await vi.importActual<typeof import("../services/slack.js")>("../services/slack.js");
  return { ...actual, ...slackMocks };
});
vi.mock("../services/activity-log.js", () => activityMocks);

import { SlackApiError, buildSlackMessageLink } from "../services/slack.js";
import { errorHandler } from "../middleware/index.js";
import { slackAgentRoutes } from "../routes/slack-agent.js";
import { resetAgentSlackMessagingState } from "../services/slack-agent-messaging.js";

const CO = "11111111-1111-4111-8111-111111111111";
const OTHER_CO = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";

const channels = [
  { id: "C1", name: "eng", isPrivate: false, isMember: true, isArchived: false },
  { id: "C2", name: "random", isPrivate: false, isMember: false, isArchived: false },
  { id: "G1", name: "secret", isPrivate: true, isMember: false, isArchived: false },
];
const members = [
  { id: "U01SAK", handle: "saksham", realName: "Saksham Jain", displayName: "saksham", title: "QA", timezone: null },
];

function message(ts: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    ts,
    threadTs: null,
    userId: "U01SAK",
    botId: null,
    subtype: null,
    text,
    replyCount: 0,
    latestReplyTs: null,
    edited: false,
    files: [],
    reactions: [],
    link: buildSlackMessageLink("C1", ts),
    ...extra,
  };
}

function app(actor: Record<string, unknown>) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use("/api", slackAgentRoutes({} as never));
  server.use(errorHandler);
  return server;
}

const agentActor = { type: "agent", agentId: AGENT, companyId: CO, runId: "run-1", keyId: null, source: "agent_jwt" };

beforeEach(() => {
  resetAgentSlackMessagingState();
  vi.clearAllMocks();
  slackMocks.listSlackChannels.mockResolvedValue(channels);
  slackMocks.listSlackMembers.mockResolvedValue(members);
  activityMocks.logActivity.mockResolvedValue(null);
});

describe("agent Slack read routes", () => {
  it("reads channel history by #name and adds the author's name", async () => {
    slackMocks.listSlackChannelMessages.mockResolvedValue({
      messages: [message("1712345678.000200", "Login breaks on Safari", { replyCount: 3 })],
      hasMore: true,
      nextCursor: "next-1",
    });
    const res = await request(app(agentActor)).get(`/api/companies/${CO}/slack/channels/%23eng/messages?limit=20&oldest=1712000000.000000`);
    expect(res.status).toBe(200);
    expect(slackMocks.listSlackChannelMessages).toHaveBeenCalledWith(expect.anything(), CO, "C1", { limit: 20, oldest: "1712000000.000000" });
    expect(res.body).toMatchObject({
      channelId: "C1",
      channelName: "eng",
      order: "newest_first",
      hasMore: true,
      nextCursor: "next-1",
      messages: [{ ts: "1712345678.000200", userName: "Saksham Jain", replyCount: 3 }],
    });
    expect(res.body.messages[0].link).toBe("https://slack.com/archives/C1/p1712345678000200");
  });

  it("reads a whole thread, oldest first", async () => {
    slackMocks.listSlackThreadMessages.mockResolvedValue({
      messages: [message("1712345678.000200", "root"), message("1712345679.000300", "reply", { threadTs: "1712345678.000200" })],
      hasMore: false,
      nextCursor: null,
    });
    const res = await request(app(agentActor)).get(`/api/companies/${CO}/slack/channels/C1/threads/1712345678.000200`);
    expect(res.status).toBe(200);
    expect(slackMocks.listSlackThreadMessages).toHaveBeenCalledWith(expect.anything(), CO, "C1", "1712345678.000200", {});
    expect(res.body).toMatchObject({ order: "oldest_first", threadTs: "1712345678.000200" });
    expect(res.body.messages.map((m: { text: string }) => m.text)).toEqual(["root", "reply"]);
  });

  it("reads one message by ts and 404s when it is gone", async () => {
    slackMocks.getSlackMessage.mockResolvedValueOnce(message("1712345678.000200", "hi"));
    const ok = await request(app(agentActor)).get(`/api/companies/${CO}/slack/channels/C1/messages/1712345678.000200`);
    expect(ok.status).toBe(200);
    expect(ok.body.message).toMatchObject({ text: "hi", userName: "Saksham Jain" });

    slackMocks.getSlackMessage.mockResolvedValueOnce(null);
    const missing = await request(app(agentActor)).get(`/api/companies/${CO}/slack/channels/C1/messages/1712345678.000999`);
    expect(missing.status).toBe(404);
  });

  it("tells the agent to join first when the bot is not in the channel", async () => {
    slackMocks.listSlackChannelMessages.mockRejectedValue(new SlackApiError("not_in_channel", { code: "not_in_channel", retryable: false, status: 200 }));
    const res = await request(app(agentActor)).get(`/api/companies/${CO}/slack/channels/random/messages`);
    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({ code: "not_in_channel" });
    expect(res.body.details.remediation).toContain("/join");
  });

  it("rejects bad ts values and unknown channels", async () => {
    expect((await request(app(agentActor)).get(`/api/companies/${CO}/slack/channels/C1/threads/abc`)).status).toBe(400);
    const unknown = await request(app(agentActor)).get(`/api/companies/${CO}/slack/channels/nope/messages`);
    expect(unknown.status).toBe(422);
    expect(unknown.body.details).toMatchObject({ code: "channel_not_found" });
  });

  it("does not let an agent read another company's Slack", async () => {
    const res = await request(app(agentActor)).get(`/api/companies/${OTHER_CO}/slack/channels/C1/messages`);
    expect(res.status).toBe(403);
    expect(slackMocks.listSlackChannelMessages).not.toHaveBeenCalled();
  });
});

describe("agent Slack join, edit, delete and react routes", () => {
  it("joins a public channel, and refuses private ones", async () => {
    slackMocks.joinSlackChannel.mockResolvedValue(undefined);
    const joined = await request(app(agentActor)).post(`/api/companies/${CO}/slack/channels/random/join`);
    expect(joined.status).toBe(200);
    expect(joined.body).toMatchObject({ channelId: "C2", joined: true, alreadyMember: false });
    expect(slackMocks.joinSlackChannel).toHaveBeenCalledWith(expect.anything(), CO, "C2");

    const already = await request(app(agentActor)).post(`/api/companies/${CO}/slack/channels/eng/join`);
    expect(already.body).toMatchObject({ alreadyMember: true });
    expect(slackMocks.joinSlackChannel).toHaveBeenCalledTimes(1);

    const priv = await request(app(agentActor)).post(`/api/companies/${CO}/slack/channels/secret/join`);
    expect(priv.status).toBe(422);
    expect(priv.body.details).toMatchObject({ code: "private_channel" });
  });

  it("edits and deletes the bot's own message, and logs both", async () => {
    slackMocks.updateSlackMessage.mockResolvedValue({ channelId: "C1", ts: "1712345678.000200" });
    slackMocks.deleteSlackMessage.mockResolvedValue(undefined);
    const edit = await request(app(agentActor))
      .patch(`/api/companies/${CO}/slack/messages`)
      .send({ channel: "eng", ts: "1712345678.000200", text: "Fixed typo" });
    expect(edit.status).toBe(200);
    expect(slackMocks.updateSlackMessage).toHaveBeenCalledWith(expect.anything(), CO, { channelId: "C1", ts: "1712345678.000200", text: "Fixed typo" });

    const del = await request(app(agentActor)).delete(`/api/companies/${CO}/slack/messages?channel=eng&ts=1712345678.000200`);
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ deleted: true });
    expect(activityMocks.logActivity.mock.calls.map((call) => call[1].action)).toEqual(["slack.message_updated", "slack.message_deleted"]);
  });

  it("maps Slack's cant_update_message to a clear error", async () => {
    slackMocks.updateSlackMessage.mockRejectedValue(new SlackApiError("cant_update_message", { code: "cant_update_message", retryable: false, status: 200 }));
    const res = await request(app(agentActor))
      .patch(`/api/companies/${CO}/slack/messages`)
      .send({ channel: "eng", ts: "1712345678.000200", text: "x" });
    expect(res.status).toBe(422);
    expect(res.body.details.remediation).toContain("bot posted");
  });

  it("adds and removes reactions, accepting :colon: names", async () => {
    slackMocks.setSlackReaction.mockResolvedValue(undefined);
    const add = await request(app(agentActor))
      .post(`/api/companies/${CO}/slack/reactions`)
      .send({ channel: "eng", ts: "1712345678.000200", name: ":eyes:" });
    expect(add.status).toBe(200);
    expect(slackMocks.setSlackReaction).toHaveBeenLastCalledWith(expect.anything(), CO, { channelId: "C1", ts: "1712345678.000200", name: "eyes", remove: false });

    await request(app(agentActor))
      .post(`/api/companies/${CO}/slack/reactions`)
      .send({ channel: "eng", ts: "1712345678.000200", name: "eyes", remove: true });
    expect(slackMocks.setSlackReaction).toHaveBeenLastCalledWith(expect.anything(), CO, expect.objectContaining({ remove: true }));
  });

  it("explains a missing reactions scope", async () => {
    slackMocks.setSlackReaction.mockRejectedValue(new SlackApiError("missing_scope", { code: "missing_scope", retryable: false, status: 200 }));
    const res = await request(app(agentActor))
      .post(`/api/companies/${CO}/slack/reactions`)
      .send({ channel: "eng", ts: "1712345678.000200", name: "eyes" });
    expect(res.status).toBe(422);
    expect(res.body.details.remediation).toContain("reconnect");
  });
});
