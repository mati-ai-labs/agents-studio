import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agents as agentsTable, issues as issuesTable } from "@paperclipai/db";

const slackMocks = vi.hoisted(() => ({
  listSlackChannels: vi.fn(),
  listSlackMembers: vi.fn(),
  postSlackMessage: vi.fn(),
}));
const activityMocks = vi.hoisted(() => ({ logActivity: vi.fn() }));

vi.mock("../services/slack.js", async () => {
  const actual = await vi.importActual<typeof import("../services/slack.js")>("../services/slack.js");
  return { ...actual, ...slackMocks };
});
vi.mock("../services/activity-log.js", () => activityMocks);

import { SlackApiError } from "../services/slack.js";
import { errorHandler } from "../middleware/index.js";
import { slackAgentRoutes } from "../routes/slack-agent.js";
import {
  AGENT_SLACK_RATE_LIMIT,
  buildAgentSlackMessage,
  canPostToSlackChannel,
  resetAgentSlackMessagingState,
  resolveSlackChannel,
  takeAgentSlackSendSlot,
} from "../services/slack-agent-messaging.js";

const CO = "11111111-1111-4111-8111-111111111111";
const OTHER_CO = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const ISSUE = "44444444-4444-4444-8444-444444444444";

const channels = [
  { id: "C1", name: "eng", isPrivate: false, isMember: false, isArchived: false },
  { id: "G1", name: "secret", isPrivate: true, isMember: false, isArchived: false },
  { id: "G2", name: "leads", isPrivate: true, isMember: true, isArchived: false },
  { id: "C9", name: "old", isPrivate: false, isMember: true, isArchived: true },
];
const members = [
  { id: "U01ASHA", handle: "asha", realName: "Asha Rao", displayName: "asha", title: "Backend lead", timezone: "Asia/Kolkata" },
  { id: "U02BEN", handle: "ben", realName: "Ben K", displayName: null, title: "Design", timezone: null },
];

function fakeDb(rows: { issue?: unknown; agent?: unknown }) {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          then: (resolve: (value: unknown[]) => unknown) => {
            if (table === issuesTable) return Promise.resolve(resolve(rows.issue ? [rows.issue] : []));
            if (table === agentsTable) return Promise.resolve(resolve(rows.agent ? [rows.agent] : []));
            return Promise.resolve(resolve([]));
          },
        }),
      }),
    }),
  };
}

function app(actor: Record<string, unknown>, rows: { issue?: unknown; agent?: unknown } = {}) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use("/api", slackAgentRoutes(fakeDb(rows) as never));
  server.use(errorHandler);
  return server;
}

const agentActor = { type: "agent", agentId: AGENT, companyId: CO, runId: "run-1", keyId: null, source: "agent_jwt" };

beforeEach(() => {
  resetAgentSlackMessagingState();
  vi.clearAllMocks();
  slackMocks.listSlackChannels.mockResolvedValue(channels);
  slackMocks.listSlackMembers.mockResolvedValue(members);
  slackMocks.postSlackMessage.mockResolvedValue({ channelId: "C1", messageTs: "1712345678.000100" });
  activityMocks.logActivity.mockResolvedValue(null);
});

describe("slack agent messaging helpers", () => {
  it("formats mentions first, dedupes them, and adds an agent + issue footer", () => {
    const text = buildAgentSlackMessage({
      text: "  Can you review the login fix?  ",
      mentionUserIds: ["U01ASHA", "U02BEN", "U01ASHA"],
      agentName: "CTO",
      issueIdentifier: "LCH-15",
      issueLink: "https://x.test/LCH/issues/LCH-15",
    });
    expect(text).toBe("<@U01ASHA> <@U02BEN> Can you review the login fix?\n\n— _CTO_ · <https://x.test/LCH/issues/LCH-15|LCH-15>");
  });

  it("posts plain text when there are no mentions or footer", () => {
    expect(buildAgentSlackMessage({ text: "hi", mentionUserIds: [] })).toBe("hi");
  });

  it("resolves channels by id, #name and case-insensitive name", () => {
    expect(resolveSlackChannel(channels, "C1")?.name).toBe("eng");
    expect(resolveSlackChannel(channels, "#ENG")?.id).toBe("C1");
    expect(resolveSlackChannel(channels, "leads")?.id).toBe("G2");
    expect(resolveSlackChannel(channels, "nope")).toBeNull();
  });

  it("allows public channels without membership but needs membership for private ones", () => {
    expect(canPostToSlackChannel(channels[0]!)).toBe(true);
    expect(canPostToSlackChannel(channels[1]!)).toBe(false);
    expect(canPostToSlackChannel(channels[2]!)).toBe(true);
    expect(canPostToSlackChannel(channels[3]!)).toBe(false);
  });

  it("limits each agent to the hourly quota and frees slots after the window", () => {
    const start = 1_000_000;
    for (let i = 0; i < AGENT_SLACK_RATE_LIMIT; i += 1) expect(takeAgentSlackSendSlot("a", start + i)).toBeNull();
    expect(takeAgentSlackSendSlot("a", start + 100)).toBeGreaterThan(0);
    expect(takeAgentSlackSendSlot("b", start + 100)).toBeNull();
    expect(takeAgentSlackSendSlot("a", start + 60 * 60 * 1_000 + 1)).toBeNull();
  });
});

describe("agent slack routes", () => {
  it("lists members for an agent in the same company", async () => {
    const res = await request(app(agentActor)).get(`/api/companies/${CO}/slack/members`);
    expect(res.status).toBe(200);
    expect(res.body.members.map((m: { id: string }) => m.id)).toEqual(["U01ASHA", "U02BEN"]);
  });

  it("rejects an agent reading another company's Slack", async () => {
    const res = await request(app(agentActor)).get(`/api/companies/${OTHER_CO}/slack/members`);
    expect(res.status).toBe(403);
    expect(slackMocks.listSlackMembers).not.toHaveBeenCalled();
  });

  it("lists non-archived channels with canPost", async () => {
    const res = await request(app(agentActor)).get(`/api/companies/${CO}/slack/channels`);
    expect(res.status).toBe(200);
    expect(res.body.channels).toEqual([
      expect.objectContaining({ id: "C1", canPost: true }),
      expect.objectContaining({ id: "G1", canPost: false }),
      expect.objectContaining({ id: "G2", canPost: true }),
    ]);
  });

  it("posts with mentions, issue link and logs activity on the issue", async () => {
    const res = await request(app(agentActor, { issue: { id: ISSUE, identifier: "LCH-15" }, agent: { name: "CTO" } }))
      .post(`/api/companies/${CO}/slack/messages`)
      .send({ channel: "#eng", text: "Please review", mentionUserIds: ["U01ASHA"], issueId: ISSUE });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ channelId: "C1", channelName: "eng", mentionUserIds: ["U01ASHA"] });
    const [, companyId, posted] = slackMocks.postSlackMessage.mock.calls[0]!;
    expect(companyId).toBe(CO);
    expect(posted.channelId).toBe("C1");
    expect(posted.text).toMatch(/^<@U01ASHA> Please review\n\n— _CTO_ · <.*\/LCH\/issues\/LCH-15\|LCH-15>$/);
    expect(activityMocks.logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "slack.message_posted",
      entityType: "issue",
      entityId: ISSUE,
      issueId: ISSUE,
      agentId: AGENT,
    }));
  });

  it("rejects mentions that are not workspace members", async () => {
    const res = await request(app(agentActor)).post(`/api/companies/${CO}/slack/messages`)
      .send({ channel: "eng", text: "hi", mentionUserIds: ["U404"] });
    expect(res.status).toBe(422);
    expect(res.body.details.unknownUserIds).toEqual(["U404"]);
    expect(slackMocks.postSlackMessage).not.toHaveBeenCalled();
  });

  it("refuses private channels the bot has not joined, with a hint", async () => {
    const res = await request(app(agentActor)).post(`/api/companies/${CO}/slack/messages`)
      .send({ channel: "secret", text: "hi" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("not_in_channel");
    expect(res.body.remediation).toMatch(/invite/);
  });

  it("returns 422 for an unknown channel and 404 for an issue in another company", async () => {
    expect((await request(app(agentActor)).post(`/api/companies/${CO}/slack/messages`).send({ channel: "x", text: "hi" })).status).toBe(422);
    const res = await request(app(agentActor)).post(`/api/companies/${CO}/slack/messages`)
      .send({ channel: "eng", text: "hi", issueId: ISSUE });
    expect(res.status).toBe(404);
    expect(slackMocks.postSlackMessage).not.toHaveBeenCalled();
  });

  it("rejects malformed input", async () => {
    const res = await request(app(agentActor)).post(`/api/companies/${CO}/slack/messages`)
      .send({ channel: "eng", text: "", mentionUserIds: ["asha"] });
    expect(res.status).toBe(400);
  });

  it("rate-limits an agent after the hourly quota with Retry-After", async () => {
    const server = app(agentActor);
    for (let i = 0; i < AGENT_SLACK_RATE_LIMIT; i += 1) {
      expect((await request(server).post(`/api/companies/${CO}/slack/messages`).send({ channel: "eng", text: `m${i}` })).status).toBe(201);
    }
    const res = await request(server).post(`/api/companies/${CO}/slack/messages`).send({ channel: "eng", text: "one more" });
    expect(res.status).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("maps Slack API failures to clear errors", async () => {
    slackMocks.postSlackMessage.mockRejectedValueOnce(new SlackApiError("not_in_channel", { code: "not_in_channel", retryable: false, status: 200 }));
    const res = await request(app(agentActor)).post(`/api/companies/${CO}/slack/messages`).send({ channel: "eng", text: "hi" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("not_in_channel");

    slackMocks.listSlackMembers.mockRejectedValueOnce(new SlackApiError("Slack is not connected for this company", { code: "slack_not_connected", retryable: false, status: 409 }));
    const notConnected = await request(app(agentActor)).get(`/api/companies/${CO}/slack/members?refresh=1`);
    expect(notConnected.status).toBe(409);
  });

  it("does not leak the bot token or call Slack for unauthenticated requests", async () => {
    const res = await request(app({ type: "none" })).get(`/api/companies/${CO}/slack/channels`);
    expect([401, 403]).toContain(res.status);
    expect(slackMocks.listSlackChannels).not.toHaveBeenCalled();
  });
});
