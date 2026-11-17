import { Router, type Request } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents as agentsTable, issues as issuesTable, slackThreadBindings } from "@paperclipai/db";
import { assertBoardOrAgent, assertCompanyAccess, getActorInfo } from "./authz.js";
import { HttpError, notFound, tooManyRequests, unprocessable } from "../errors.js";
import {
  deleteSlackMessage,
  getSlackMessage,
  joinSlackChannel,
  listSlackChannelMessages,
  listSlackThreadMessages,
  postSlackMessage,
  setSlackReaction,
  SlackApiError,
  updateSlackMessage,
  type SlackChannel,
  type SlackMessage,
} from "../services/slack.js";
import {
  closeSlackPoll,
  createSlackPoll,
  getSlackPoll,
  listSlackPollsForIssue,
  SLACK_POLL_MAX_OPTIONS,
  SLACK_POLL_MIN_OPTIONS,
  summarizeSlackPoll,
} from "../services/slack-polls.js";
import { buildIssueLink } from "../services/slack-message-builder.js";
import { logActivity } from "../services/activity-log.js";
import {
  AGENT_SLACK_MAX_MENTIONS,
  AGENT_SLACK_MAX_TEXT_LENGTH,
  bindAgentSlackThread,
  buildAgentSlackMessage,
  canPostToSlackChannel,
  getCachedSlackChannels,
  getCachedSlackMembers,
  resolveSlackChannel,
  slackChannelDeliversReplies,
  takeAgentSlackSendSlot,
} from "../services/slack-agent-messaging.js";

export const agentSlackMessageSchema = z.object({
  /** Channel id (C…/G…), `#name` or `name`. */
  channel: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(AGENT_SLACK_MAX_TEXT_LENGTH),
  mentionUserIds: z.array(z.string().trim().regex(/^[UW][A-Z0-9]{2,}$/, "Slack user ids look like U0123ABCD"))
    .max(AGENT_SLACK_MAX_MENTIONS)
    .optional()
    .default([]),
  threadTs: z.string().trim().regex(/^\d+\.\d+$/, "threadTs looks like 1712345678.123456").optional().nullable(),
  issueId: z.string().uuid().optional().nullable(),
});

const slackTs = z.string().trim().regex(/^\d+\.\d+$/, "Slack ts looks like 1712345678.123456");

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  oldest: slackTs.optional(),
  latest: slackTs.optional(),
  cursor: z.string().trim().min(1).max(500).optional(),
});

export const agentSlackUpdateSchema = z.object({
  channel: z.string().trim().min(1).max(200),
  ts: slackTs,
  text: z.string().trim().min(1).max(AGENT_SLACK_MAX_TEXT_LENGTH),
});

export const agentSlackDeleteSchema = z.object({
  channel: z.string().trim().min(1).max(200),
  ts: slackTs,
});

export const agentSlackReactionSchema = z.object({
  channel: z.string().trim().min(1).max(200),
  ts: slackTs,
  /** Emoji name without colons, e.g. `white_check_mark` or `eyes`. */
  name: z.string().trim().min(1).max(100).transform((value) => value.replace(/^:|:$/g, "")),
  remove: z.boolean().optional().default(false),
});

export const agentSlackPollSchema = z.object({
  channel: z.string().trim().min(1).max(200),
  question: z.string().trim().min(1).max(300),
  options: z.array(z.string().trim().min(1).max(75)).min(SLACK_POLL_MIN_OPTIONS).max(SLACK_POLL_MAX_OPTIONS)
    .refine((values) => new Set(values.map((value) => value.toLowerCase())).size === values.length, "Poll options must be unique"),
  multiSelect: z.boolean().optional().default(false),
  issueId: z.string().uuid(),
  threadTs: slackTs.optional().nullable(),
  mentionUserIds: z.array(z.string().trim().regex(/^[UW][A-Z0-9]{2,}$/, "Slack user ids look like U0123ABCD"))
    .max(AGENT_SLACK_MAX_MENTIONS)
    .optional()
    .default([]),
  /** ISO timestamp or minutes from now; the poll closes itself after this. */
  closesAt: z.string().datetime().optional().nullable(),
  closesInMinutes: z.number().int().min(1).max(60 * 24 * 14).optional().nullable(),
});

const SLACK_ERROR_HINTS: Record<string, string> = {
  not_in_channel: "The Slack bot is not a member of that channel. Ask a human to invite it, or pick another channel.",
  channel_not_found: "Channel not found. List channels with GET /api/companies/:companyId/slack/channels.",
  is_archived: "That channel is archived.",
  missing_scope: "The Slack app is missing a scope for this action. A human must update the Slack app and reconnect.",
  slack_not_connected: "Slack is not connected for this company.",
  cant_update_message: "Only messages the Paperclip bot posted can be edited.",
  cant_delete_message: "Only messages the Paperclip bot posted can be deleted.",
  message_not_found: "No message with that ts in this channel.",
  thread_not_found: "No thread with that ts in this channel. Use the root message's ts.",
  invalid_name: "Unknown emoji name. Use the name without colons, e.g. eyes or white_check_mark.",
  too_many_reactions: "That message has too many reactions already.",
};

const READ_ERROR_HINTS: Record<string, string> = {
  not_in_channel: "The bot is not in that channel, so it cannot read it. For a public channel, POST /api/companies/:companyId/slack/channels/:channel/join first. A private channel needs a human to invite the bot.",
};

const REPLY_TRACKING_HINTS: Record<string, string> = {
  not_bound: "The message was posted, but replies will not reach the issue (thread binding failed). Check the issue for replies manually.",
  thread_belongs_to_other_issue: "That thread already belongs to another issue; replies go there.",
  private_channel_unsupported: "Replies in private channels do not reach the issue. Prefer a public channel the bot is in.",
  bot_not_in_channel: "The bot is not a member of this channel, so Slack does not send it replies. Ask a human to invite the bot, or prefer a channel with repliesForwarded: true.",
};

function toHttpError(error: unknown, hints: Record<string, string> = SLACK_ERROR_HINTS): unknown {
  if (!(error instanceof SlackApiError)) return error;
  const hint = hints[error.code] ?? SLACK_ERROR_HINTS[error.code];
  // Slack reports most failures as HTTP 200 with ok:false, so map by code.
  const status = error.code === "slack_not_connected" || error.code.startsWith("slack_missing") || error.code.startsWith("slack_refresh")
    ? 409
    : hint
      ? 422
      : error.status >= 400 && error.status < 600
        ? error.status
        : 502;
  return new HttpError(status, `Slack error: ${error.code}`, {
    code: error.code,
    ...(hint ? { remediation: hint } : {}),
  });
}

function readRefresh(req: Request) {
  const value = req.query.refresh;
  return value === "1" || value === "true";
}

async function requireChannel(db: Db, companyId: string, ref: string): Promise<SlackChannel> {
  let channel = resolveSlackChannel(await getCachedSlackChannels(db, companyId), ref);
  // A channel created or joined in the last few minutes is not in the cache yet.
  if (!channel) channel = resolveSlackChannel(await getCachedSlackChannels(db, companyId, { refresh: true }), ref);
  if (!channel) {
    throw unprocessable("Unknown Slack channel", {
      code: "channel_not_found",
      remediation: SLACK_ERROR_HINTS.channel_not_found,
    });
  }
  return channel;
}

async function requireIssue(db: Db, companyId: string, issueId: string) {
  const issue = await db
    .select({ id: issuesTable.id, identifier: issuesTable.identifier })
    .from(issuesTable)
    .where(and(eq(issuesTable.id, issueId), eq(issuesTable.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!issue) throw notFound("Issue not found");
  return issue;
}

async function withUserNames(db: Db, companyId: string, messages: SlackMessage[]) {
  const members = await getCachedSlackMembers(db, companyId).catch(() => []);
  const names = new Map(members.map((member) => [member.id, member.realName ?? member.displayName ?? member.handle ?? member.id]));
  return messages.map((message) => ({
    ...message,
    userName: message.userId ? names.get(message.userId) ?? null : null,
  }));
}

function takeSendSlot(req: Request, res: { setHeader(name: string, value: string): void }, companyId: string) {
  const actor = getActorInfo(req);
  if (actor.actorType !== "agent") return;
  const waitSeconds = takeAgentSlackSendSlot(`${companyId}:${actor.agentId ?? actor.actorId}`);
  if (waitSeconds !== null) {
    res.setHeader("Retry-After", String(waitSeconds));
    throw tooManyRequests("Slack message limit reached for this agent (20 per hour)", {
      code: "agent_slack_rate_limited",
      retryAfterSeconds: waitSeconds,
    });
  }
}

async function readAgentName(db: Db, companyId: string, agentId: string | null | undefined) {
  if (!agentId) return null;
  return db
    .select({ name: agentsTable.name })
    .from(agentsTable)
    .where(and(eq(agentsTable.id, agentId), eq(agentsTable.companyId, companyId)))
    .then((rows) => rows[0]?.name ?? null);
}

export function slackAgentRoutes(db: Db): Router {
  const router = Router();

  router.get("/companies/:companyId/slack/members", async (req, res, next) => {
    try {
      assertBoardOrAgent(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const members = await getCachedSlackMembers(db, companyId, { refresh: readRefresh(req) });
      res.json({ members });
    } catch (error) {
      next(toHttpError(error));
    }
  });

  router.get("/companies/:companyId/slack/channels", async (req, res, next) => {
    try {
      assertBoardOrAgent(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const channels = await getCachedSlackChannels(db, companyId, { refresh: readRefresh(req) });
      res.json({
        channels: channels
          .filter((channel) => !channel.isArchived)
          .map((channel) => ({
            ...channel,
            canPost: canPostToSlackChannel(channel),
            repliesForwarded: slackChannelDeliversReplies(channel),
          })),
      });
    } catch (error) {
      next(toHttpError(error));
    }
  });

  router.post("/companies/:companyId/slack/messages", async (req, res, next) => {
    try {
      assertBoardOrAgent(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const input = agentSlackMessageSchema.parse(req.body ?? {});
      const actor = getActorInfo(req);

      const channels = await getCachedSlackChannels(db, companyId);
      const channel = resolveSlackChannel(channels, input.channel);
      if (!channel) {
        throw unprocessable("Unknown Slack channel", {
          code: "channel_not_found",
          remediation: SLACK_ERROR_HINTS.channel_not_found,
        });
      }
      if (!canPostToSlackChannel(channel)) {
        throw unprocessable(`Cannot post to #${channel.name}`, {
          code: channel.isArchived ? "is_archived" : "not_in_channel",
          remediation: channel.isArchived ? SLACK_ERROR_HINTS.is_archived : SLACK_ERROR_HINTS.not_in_channel,
        });
      }

      const mentionUserIds = [...new Set(input.mentionUserIds)];
      if (mentionUserIds.length > 0) {
        const members = await getCachedSlackMembers(db, companyId);
        const known = new Set(members.map((member) => member.id));
        const unknown = mentionUserIds.filter((id) => !known.has(id));
        if (unknown.length > 0) {
          throw unprocessable("Unknown Slack user ids in mentionUserIds", {
            code: "unknown_mention",
            unknownUserIds: unknown,
            remediation: "Use ids from GET /api/companies/:companyId/slack/members.",
          });
        }
      }

      const issue = input.issueId
        ? await db
          .select({ id: issuesTable.id, identifier: issuesTable.identifier })
          .from(issuesTable)
          .where(and(eq(issuesTable.id, input.issueId), eq(issuesTable.companyId, companyId)))
          .then((rows) => rows[0] ?? null)
        : null;
      if (input.issueId && !issue) throw notFound("Issue not found");

      const agentName = actor.agentId
        ? await db
          .select({ name: agentsTable.name })
          .from(agentsTable)
          .where(and(eq(agentsTable.id, actor.agentId), eq(agentsTable.companyId, companyId)))
          .then((rows) => rows[0]?.name ?? null)
        : null;

      if (actor.actorType === "agent") {
        const waitSeconds = takeAgentSlackSendSlot(`${companyId}:${actor.agentId ?? actor.actorId}`);
        if (waitSeconds !== null) {
          res.setHeader("Retry-After", String(waitSeconds));
          throw tooManyRequests("Slack message limit reached for this agent (20 per hour)", {
            code: "agent_slack_rate_limited",
            retryAfterSeconds: waitSeconds,
          });
        }
      }

      const text = buildAgentSlackMessage({
        text: input.text,
        mentionUserIds,
        agentName,
        issueIdentifier: issue?.identifier ?? null,
        issueLink: issue ? buildIssueLink(issue) : null,
      });
      const posted = await postSlackMessage(db, companyId, {
        channelId: channel.id,
        text,
        threadTs: input.threadTs ?? null,
      });

      // Bind the thread to the issue so replies come back as issue comments.
      const rootTs = input.threadTs ?? posted.messageTs;
      const binding = issue && rootTs
        ? await bindAgentSlackThread(db, { companyId, issueId: issue.id, channel, threadTs: rootTs })
        : null;
      const repliesForwarded = Boolean(
        binding && (binding.status === "bound" || binding.status === "already_bound") && slackChannelDeliversReplies(channel),
      );
      const replyTracking = !issue
        ? "no_issue"
        : !binding || binding.status === "skipped"
          ? "not_bound"
          : binding.status === "bound_to_other_issue"
            ? "thread_belongs_to_other_issue"
            : repliesForwarded
              ? "active"
              : channel.isPrivate
                ? "private_channel_unsupported"
                : "bot_not_in_channel";

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        issueId: issue?.id ?? null,
        action: "slack.message_posted",
        entityType: issue ? "issue" : "company",
        entityId: issue?.id ?? companyId,
        details: {
          channelId: channel.id,
          channelName: channel.name,
          messageTs: posted.messageTs,
          threadTs: input.threadTs ?? null,
          mentionUserIds,
          text: input.text.slice(0, 500),
          replyTracking,
          ...(binding && "bindingId" in binding ? { bindingId: binding.bindingId } : {}),
          ...(binding?.status === "skipped" ? { bindingSkippedReason: binding.reason } : {}),
        },
      });

      res.status(201).json({
        channelId: posted.channelId,
        channelName: channel.name,
        messageTs: posted.messageTs,
        mentionUserIds,
        replyTracking,
        ...(issue && replyTracking !== "active" ? { replyTrackingHint: REPLY_TRACKING_HINTS[replyTracking] } : {}),
      });
    } catch (error) {
      next(toHttpError(error));
    }
  });

  router.post("/companies/:companyId/slack/channels/:channel/join", async (req, res, next) => {
    try {
      assertBoardOrAgent(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const channel = await requireChannel(db, companyId, req.params.channel as string);
      if (channel.isPrivate) {
        throw unprocessable(`#${channel.name} is private; the bot cannot join it by itself`, {
          code: "private_channel",
          remediation: "Ask a human to invite the Paperclip bot to the channel.",
        });
      }
      if (!channel.isMember) {
        await joinSlackChannel(db, companyId, channel.id);
        await getCachedSlackChannels(db, companyId, { refresh: true }).catch(() => null);
      }
      res.json({ channelId: channel.id, channelName: channel.name, joined: true, alreadyMember: channel.isMember });
    } catch (error) {
      next(toHttpError(error));
    }
  });

  router.get("/companies/:companyId/slack/channels/:channel/messages", async (req, res, next) => {
    try {
      assertBoardOrAgent(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const query = historyQuerySchema.parse(req.query ?? {});
      const channel = await requireChannel(db, companyId, req.params.channel as string);
      const page = await listSlackChannelMessages(db, companyId, channel.id, query);
      res.json({
        channelId: channel.id,
        channelName: channel.name,
        order: "newest_first",
        messages: await withUserNames(db, companyId, page.messages),
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      next(toHttpError(error, READ_ERROR_HINTS));
    }
  });

  router.get("/companies/:companyId/slack/channels/:channel/messages/:ts", async (req, res, next) => {
    try {
      assertBoardOrAgent(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const ts = slackTs.parse(req.params.ts);
      const channel = await requireChannel(db, companyId, req.params.channel as string);
      const message = await getSlackMessage(db, companyId, channel.id, ts);
      if (!message) throw notFound("Slack message not found");
      const [named] = await withUserNames(db, companyId, [message]);
      res.json({ channelId: channel.id, channelName: channel.name, message: named });
    } catch (error) {
      next(toHttpError(error, READ_ERROR_HINTS));
    }
  });

  router.get("/companies/:companyId/slack/channels/:channel/threads/:threadTs", async (req, res, next) => {
    try {
      assertBoardOrAgent(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const threadTs = slackTs.parse(req.params.threadTs);
      const query = historyQuerySchema.pick({ limit: true, cursor: true }).parse(req.query ?? {});
      const channel = await requireChannel(db, companyId, req.params.channel as string);
      const page = await listSlackThreadMessages(db, companyId, channel.id, threadTs, query);
      res.json({
        channelId: channel.id,
        channelName: channel.name,
        threadTs,
        order: "oldest_first",
        messages: await withUserNames(db, companyId, page.messages),
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      next(toHttpError(error, READ_ERROR_HINTS));
    }
  });

  router.patch("/companies/:companyId/slack/messages", async (req, res, next) => {
    try {
      assertBoardOrAgent(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const input = agentSlackUpdateSchema.parse(req.body ?? {});
      const actor = getActorInfo(req);
      const channel = await requireChannel(db, companyId, input.channel);
      const updated = await updateSlackMessage(db, companyId, { channelId: channel.id, ts: input.ts, text: input.text });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "slack.message_updated",
        entityType: "company",
        entityId: companyId,
        details: { channelId: channel.id, channelName: channel.name, messageTs: input.ts, text: input.text.slice(0, 500) },
      });
      res.json({ channelId: updated.channelId, channelName: channel.name, messageTs: updated.ts });
    } catch (error) {
      next(toHttpError(error));
    }
  });

  router.delete("/companies/:companyId/slack/messages", async (req, res, next) => {
    try {
      assertBoardOrAgent(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const input = agentSlackDeleteSchema.parse({ ...(req.query ?? {}), ...(req.body ?? {}) });
      const actor = getActorInfo(req);
      const channel = await requireChannel(db, companyId, input.channel);
      await deleteSlackMessage(db, companyId, { channelId: channel.id, ts: input.ts });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "slack.message_deleted",
        entityType: "company",
        entityId: companyId,
        details: { channelId: channel.id, channelName: channel.name, messageTs: input.ts },
      });
      res.json({ channelId: channel.id, channelName: channel.name, messageTs: input.ts, deleted: true });
    } catch (error) {
      next(toHttpError(error));
    }
  });

  router.post("/companies/:companyId/slack/reactions", async (req, res, next) => {
    try {
      assertBoardOrAgent(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const input = agentSlackReactionSchema.parse(req.body ?? {});
      const channel = await requireChannel(db, companyId, input.channel);
      await setSlackReaction(db, companyId, { channelId: channel.id, ts: input.ts, name: input.name, remove: input.remove });
      res.json({ channelId: channel.id, channelName: channel.name, messageTs: input.ts, name: input.name, removed: input.remove });
    } catch (error) {
      next(toHttpError(error));
    }
  });

  router.get("/companies/:companyId/issues/:issueId/slack/threads", async (req, res, next) => {
    try {
      assertBoardOrAgent(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const issue = await requireIssue(db, companyId, req.params.issueId as string);
      const bindings = await db
        .select({
          channelId: slackThreadBindings.channelId,
          channelName: slackThreadBindings.channelName,
          threadTs: slackThreadBindings.threadTs,
          source: slackThreadBindings.source,
          rootUserId: slackThreadBindings.rootUserId,
          lastInboundAt: slackThreadBindings.lastInboundAt,
          createdAt: slackThreadBindings.createdAt,
        })
        .from(slackThreadBindings)
        .where(and(eq(slackThreadBindings.companyId, companyId), eq(slackThreadBindings.issueId, issue.id)));
      res.json({ issueId: issue.id, identifier: issue.identifier, threads: bindings });
    } catch (error) {
      next(toHttpError(error));
    }
  });

  router.post("/companies/:companyId/slack/polls", async (req, res, next) => {
    try {
      assertBoardOrAgent(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const input = agentSlackPollSchema.parse(req.body ?? {});
      const actor = getActorInfo(req);
      const channel = await requireChannel(db, companyId, input.channel);
      if (!canPostToSlackChannel(channel)) {
        throw unprocessable(`Cannot post to #${channel.name}`, {
          code: channel.isArchived ? "is_archived" : "not_in_channel",
          remediation: channel.isArchived ? SLACK_ERROR_HINTS.is_archived : SLACK_ERROR_HINTS.not_in_channel,
        });
      }
      const mentionUserIds = [...new Set(input.mentionUserIds)];
      if (mentionUserIds.length > 0) {
        const known = new Set((await getCachedSlackMembers(db, companyId)).map((member) => member.id));
        const unknown = mentionUserIds.filter((id) => !known.has(id));
        if (unknown.length > 0) {
          throw unprocessable("Unknown Slack user ids in mentionUserIds", {
            code: "unknown_mention",
            unknownUserIds: unknown,
            remediation: "Use ids from GET /api/companies/:companyId/slack/members.",
          });
        }
      }
      const issue = await requireIssue(db, companyId, input.issueId);
      const closesAt = input.closesAt
        ? new Date(input.closesAt)
        : input.closesInMinutes
          ? new Date(Date.now() + input.closesInMinutes * 60_000)
          : null;
      if (closesAt && closesAt.getTime() <= Date.now()) throw unprocessable("closesAt must be in the future");
      takeSendSlot(req, res, companyId);

      const { poll, binding } = await createSlackPoll(db, {
        companyId,
        issue,
        agentId: actor.agentId ?? null,
        agentName: await readAgentName(db, companyId, actor.agentId),
        channel,
        question: input.question,
        options: input.options,
        multiSelect: input.multiSelect,
        threadTs: input.threadTs ?? null,
        mentionUserIds,
        closesAt,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        issueId: issue.id,
        action: "slack.poll_posted",
        entityType: "issue",
        entityId: issue.id,
        details: {
          pollId: poll.id,
          channelId: channel.id,
          channelName: channel.name,
          messageTs: poll.messageTs,
          question: poll.question,
          options: input.options,
          mentionUserIds,
          bindingStatus: binding.status,
        },
      });
      res.status(201).json(summarizeSlackPoll(poll));
    } catch (error) {
      next(toHttpError(error));
    }
  });

  router.get("/companies/:companyId/slack/polls/:pollId", async (req, res, next) => {
    try {
      assertBoardOrAgent(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const pollId = z.string().uuid().parse(req.params.pollId);
      const poll = await getSlackPoll(db, companyId, pollId);
      if (!poll) throw notFound("Slack poll not found");
      res.json(summarizeSlackPoll(poll));
    } catch (error) {
      next(toHttpError(error));
    }
  });

  router.post("/companies/:companyId/slack/polls/:pollId/close", async (req, res, next) => {
    try {
      assertBoardOrAgent(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const pollId = z.string().uuid().parse(req.params.pollId);
      const existing = await getSlackPoll(db, companyId, pollId);
      if (!existing) throw notFound("Slack poll not found");
      const actor = getActorInfo(req);
      const poll = existing.status === "open"
        ? await closeSlackPoll(db, pollId, { reason: "agent", closedByAgentId: actor.agentId ?? null })
        : existing;
      res.json(summarizeSlackPoll(poll ?? existing));
    } catch (error) {
      next(toHttpError(error));
    }
  });

  router.get("/companies/:companyId/issues/:issueId/slack/polls", async (req, res, next) => {
    try {
      assertBoardOrAgent(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const issue = await requireIssue(db, companyId, req.params.issueId as string);
      const polls = await listSlackPollsForIssue(db, companyId, issue.id);
      res.json({ issueId: issue.id, polls: polls.map(summarizeSlackPoll) });
    } catch (error) {
      next(toHttpError(error));
    }
  });

  return router;
}
