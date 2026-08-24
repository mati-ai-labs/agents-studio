import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { slackEventDeliveries } from "@paperclipai/db";
import { verifySlackSignature } from "../services/slack-signature.js";
import { logger } from "../middleware/logger.js";

type Kick = () => void;

function header(req: { get(name: string): string | undefined }, name: string): string | undefined {
  return req.get(name) ?? undefined;
}

export function slackEventsRoute(db: Db, kick?: Kick): Router {
  const router = Router();
  router.post("/events", async (req, res) => {
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    const valid = verifySlackSignature(rawBody, {
      timestamp: header(req, "x-slack-request-timestamp"),
      signature: header(req, "x-slack-signature"),
    }, process.env.SLACK_SIGNING_SECRET);
    if (!valid) {
      res.status(401).json({ error: "Invalid Slack signature" });
      return;
    }
    const body = req.body as Record<string, unknown>;
    if (process.env.SLACK_APP_ID && body.api_app_id !== process.env.SLACK_APP_ID) {
      res.status(401).json({ error: "Invalid Slack application" });
      return;
    }
    if (body.type === "url_verification") {
      res.json({ challenge: body.challenge });
      return;
    }
    if (body.type !== "event_callback") {
      res.status(200).json({ ok: true });
      return;
    }
    const event = (body.event && typeof body.event === "object" ? body.event : {}) as Record<string, unknown>;
    const eventType = event.type === "app_mention" ? "app_mention" : event.type === "message" ? "message.channels" : null;
    const eventId = typeof body.event_id === "string" ? body.event_id.trim() : "";
    const workspaceId = typeof body.team_id === "string" ? body.team_id.trim() : "";
    const eventUserId = typeof event.user === "string" ? event.user.trim() : "";
    const channelId = typeof event.channel === "string" ? event.channel.trim() : null;
    const messageTs = typeof event.ts === "string" ? event.ts.trim() : null;
    const threadTs = typeof event.thread_ts === "string" ? event.thread_ts.trim() : null;
    const text = typeof event.text === "string" ? event.text.trim() : "";
    const ignored = !eventType || !eventId || !workspaceId || !channelId || !messageTs || !eventUserId || !text || event.subtype || event.bot_id || (eventType === "message.channels" && !threadTs);
    try {
      await db.insert(slackEventDeliveries).values({
        eventId: eventId || `ignored:${Date.now()}:${Math.random()}`,
        workspaceId: workspaceId || "unknown",
        apiAppId: typeof body.api_app_id === "string" ? body.api_app_id : null,
        eventType: eventType ?? "ignored",
        channelId,
        threadTs,
        messageTs,
        eventUserId: eventUserId || null,
        payload: {
          eventType: eventType ?? "ignored",
          eventId,
          workspaceId,
          userId: eventUserId,
          text,
          channelId,
          ts: messageTs,
          threadTs,
          eventTs: typeof event.event_ts === "string" ? event.event_ts : null,
        },
        ...(ignored ? { status: "ignored" as const, processedAt: new Date(), lastError: "unsupported Slack event" } : {}),
      }).onConflictDoNothing();
    } catch (error) {
      logger.error({ err: error }, "Failed to persist Slack event delivery");
      res.status(503).json({ error: "Slack event persistence unavailable" });
      return;
    }
    if (!ignored) kick?.();
    res.status(200).json({ ok: true });
  });
  return router;
}
