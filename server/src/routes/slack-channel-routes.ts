import { Router, type Request, type Response, type NextFunction } from "express";
import type { Db } from "@paperclipai/db";
import { slackChannelRoutes as slackChannelRoutesTable } from "@paperclipai/db";
import { upsertSlackChannelRouteSchema } from "@paperclipai/shared";
import { connectorRegistryService } from "../services/connector-registry.js";
import { listSlackChannels, readSlackWorkspaceMetadata } from "../services/slack.js";
import { slackChannelRouteService } from "../services/slack-channel-route-service.js";
import { assertAuthenticated, assertBoard, assertCompanyAccess } from "./authz.js";

function companyId(req: { query: Record<string, unknown> }): string {
  const value = req.query.companyId;
  if (typeof value !== "string" || !value.trim()) throw new Error("companyId query parameter is required");
  return value.trim();
}

export function slackChannelRoutes(db: Db): Router {
  const router = Router();
  const service = slackChannelRouteService(db);
  const registry = connectorRegistryService(db);
  router.get("/channel-routes", async (req, res, next) => {
    try { assertAuthenticated(req); assertBoard(req); const id = companyId(req); assertCompanyAccess(req, id); const rows = await service.list(id, Number(req.query.offset ?? 0), Number(req.query.limit ?? 100)); res.json({ routes: rows.map(({ route, assigneeAgentName }) => ({ ...route, assigneeAgentName })) }); } catch (error) { next(error); }
  });
  const upsertHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertAuthenticated(req); assertBoard(req); const id = companyId(req); assertCompanyAccess(req, id);
      const input = upsertSlackChannelRouteSchema.parse(req.body);
      const connector = await registry.getByType(id, "slack", null);
      if (!connector || connector.status !== "connected") { res.status(409).json({ error: "Connected Slack connector required" }); return; }
      const workspace = readSlackWorkspaceMetadata(connector.config);
      if (!workspace) { res.status(409).json({ error: "Slack connector has no workspace metadata" }); return; }
      const credentials = await registry.getCredentialsForAgentAsync(id, "slack");
      if (!credentials) { res.status(409).json({ error: "Slack credentials unavailable" }); return; }
      const requestedChannelId = req.params.channelId ?? (typeof req.body.channelId === "string" ? req.body.channelId : "");
      const channel = (await listSlackChannels(credentials.credentials.accessToken)).find((item) => item.id === requestedChannelId);
      if (!channel || channel.channelType !== "public" || !channel.isMember) { res.status(422).json({ error: "Slack channel must be a joined public channel" }); return; }
      const route = await service.upsert({ companyId: id, connectorId: connector.id, workspaceId: workspace.workspaceId, channelId: channel.id, channelName: channel.name, assigneeAgentId: input.assigneeAgentId, enabled: input.enabled, createdByUserId: req.actor.userId ?? null });
      res.json(route);
    } catch (error) { next(error); }
  };
  router.put("/channel-routes/:channelId", upsertHandler);
  router.patch("/channel-routes/:channelId", upsertHandler);
  router.post("/channel-routes", upsertHandler);
  router.get("/events-info", async (req, res, next) => {
    try {
      assertAuthenticated(req); assertBoard(req); const id = companyId(req); assertCompanyAccess(req, id);
      const connector = await registry.getByType(id, "slack", null);
      const workspace = readSlackWorkspaceMetadata(connector?.config);
      const scopes = workspace?.scope ?? [];
      const required = ["app_mentions:read", "channels:history", "channels:read", "chat:write"];
      const missingScopes = required.filter((scope) => !scopes.includes(scope));
      const rows = await service.list(id, 0, 200);
      res.json({ eventRequestUrl: `${process.env.PAPERCLIP_PUBLIC_URL?.replace(/\/+$/, "") || ""}/api/connectors/slack/events`, signingSecretConfigured: Boolean(process.env.SLACK_SIGNING_SECRET), appIdConfigured: Boolean(process.env.SLACK_APP_ID), requiredScopesPresent: missingScopes.length === 0, missingScopes, enabledChannelRouteCount: rows.filter(({ route }) => route.enabled).length, workspaceId: workspace?.workspaceId ?? null, workspaceName: workspace?.workspaceName ?? null, scopes });
    } catch (error) { next(error); }
  });
  router.delete("/channel-routes/:channelId", async (req, res, next) => { try { assertAuthenticated(req); assertBoard(req); const id = companyId(req); assertCompanyAccess(req, id); const route = await service.remove(id, req.params.channelId); if (!route) { res.status(404).json({ error: "Slack channel route not found" }); return; } res.json({ success: true }); } catch (error) { next(error); } });
  return router;
}
