import { Router, type Request } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents as agentsTable, issues as issuesTable } from "@paperclipai/db";
import { assertBoardOrAgent, assertCompanyAccess, getActorInfo } from "./authz.js";
import { HttpError, notFound, tooManyRequests, unprocessable } from "../errors.js";
import { postSlackMessage, SlackApiError } from "../services/slack.js";
import { buildIssueLink } from "../services/slack-message-builder.js";
import { logActivity } from "../services/activity-log.js";
import {
  AGENT_SLACK_MAX_MENTIONS,
  AGENT_SLACK_MAX_TEXT_LENGTH,
  buildAgentSlackMessage,
  canPostToSlackChannel,
  getCachedSlackChannels,
  getCachedSlackMembers,
  resolveSlackChannel,
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

const SLACK_ERROR_HINTS: Record<string, string> = {
  not_in_channel: "The Slack bot is not a member of that channel. Ask a human to invite it, or pick another channel.",
  channel_not_found: "Channel not found. List channels with GET /api/companies/:companyId/slack/channels.",
  is_archived: "That channel is archived.",
  missing_scope: "The Slack app is missing a scope for this action. A human must update the Slack app and reconnect.",
  slack_not_connected: "Slack is not connected for this company.",
};

function toHttpError(error: unknown): unknown {
  if (!(error instanceof SlackApiError)) return error;
  const hint = SLACK_ERROR_HINTS[error.code];
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
          .map((channel) => ({ ...channel, canPost: canPostToSlackChannel(channel) })),
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
        },
      });

      res.status(201).json({
        channelId: posted.channelId,
        channelName: channel.name,
        messageTs: posted.messageTs,
        mentionUserIds,
      });
    } catch (error) {
      next(toHttpError(error));
    }
  });

  return router;
}
