import { Router, urlencoded } from "express";
import type { Db } from "@paperclipai/db";
import { verifySlackSignature } from "../services/slack-signature.js";
import { recordSlackPollVote, SLACK_POLL_VOTE_ACTION_PREFIX } from "../services/slack-polls.js";
import { logger } from "../middleware/logger.js";

type BlockAction = { action_id?: unknown; value?: unknown };

type InteractionPayload = {
  type?: unknown;
  api_app_id?: unknown;
  user?: { id?: unknown };
  channel?: { id?: unknown };
  container?: { channel_id?: unknown; message_ts?: unknown };
  message?: { ts?: unknown };
  actions?: BlockAction[];
};

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Slack interactivity (Request URL: <public base>/api/connectors/slack/interactions).
 * Handles poll button clicks. Slack wants a 200 within 3 seconds, so the click is
 * acknowledged first and processed right after.
 */
export function slackInteractionsRoute(db: Db, options: { pluginWorkerManager?: unknown } = {}): Router {
  const router = Router();
  router.post(
    "/interactions",
    urlencoded({
      extended: false,
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
    (req, res) => {
      const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
      const valid = verifySlackSignature(rawBody, {
        timestamp: req.get("x-slack-request-timestamp") ?? undefined,
        signature: req.get("x-slack-signature") ?? undefined,
      }, process.env.SLACK_SIGNING_SECRET);
      if (!valid) {
        res.status(401).json({ error: "Invalid Slack signature" });
        return;
      }

      let payload: InteractionPayload;
      try {
        payload = JSON.parse(String((req.body as Record<string, unknown>)?.payload ?? "{}")) as InteractionPayload;
      } catch {
        res.status(400).json({ error: "Invalid interaction payload" });
        return;
      }
      if (process.env.SLACK_APP_ID && payload.api_app_id !== process.env.SLACK_APP_ID) {
        res.status(401).json({ error: "Invalid Slack application" });
        return;
      }
      res.status(200).end();
      if (payload.type !== "block_actions") return;

      const slackUserId = readString(payload.user?.id);
      const channelId = readString(payload.container?.channel_id) ?? readString(payload.channel?.id);
      const messageTs = readString(payload.container?.message_ts) ?? readString(payload.message?.ts);
      for (const action of payload.actions ?? []) {
        const actionId = readString(action.action_id);
        const value = readString(action.value);
        if (!actionId?.startsWith(`${SLACK_POLL_VOTE_ACTION_PREFIX}:`) || !value || !slackUserId) continue;
        const [pollId, optionId] = value.split(":");
        if (!pollId || !optionId || !/^[0-9a-f-]{36}$/i.test(pollId)) continue;
        void recordSlackPollVote(db, {
          pollId,
          optionId,
          slackUserId,
          channelId,
          messageTs,
          pluginWorkerManager: options.pluginWorkerManager,
        }).catch((error) => {
          logger.error({ err: error, pollId }, "Failed to record Slack poll vote");
        });
      }
    },
  );
  return router;
}
