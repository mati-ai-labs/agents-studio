import { Router, urlencoded } from "express";
import type { Db } from "@paperclipai/db";
import { handleSlackSlashCommand } from "../services/slack-slash-command-handler.js";
import { verifySlackSignature } from "../services/slack-signature.js";

export function slackSlashCommandsRoute(db: Db): Router {
  const router = Router();
  router.post("/slash-commands", urlencoded({ extended: false }), async (req, res) => {
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (rawBody && !verifySlackSignature(rawBody, { timestamp: req.get("x-slack-request-timestamp") ?? undefined, signature: req.get("x-slack-signature") ?? undefined }, process.env.SLACK_SIGNING_SECRET)) { res.status(401).json({ error: "Invalid Slack signature" }); return; }
    const response = await handleSlackSlashCommand(db, { workspaceId: String(req.body.team_id ?? ""), channelId: String(req.body.channel_id ?? ""), text: String(req.body.text ?? "") });
    res.json(response);
  });
  return router;
}
