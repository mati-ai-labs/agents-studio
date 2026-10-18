import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, companyConnectors } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { listSlackChannels, readSlackWorkspaceMetadata } from "../services/slack.js";
import { slackChannelRouteService } from "../services/slack-channel-route-service.js";
import { assertInstanceAdmin } from "./authz.js";

const upsertSchema = z
  .object({
    connectorId: z.string().uuid(),
    channelId: z.string().min(1),
    companyId: z.string().uuid(),
    assigneeAgentId: z.string().uuid(),
    enabled: z.boolean().optional(),
  })
  .strict();

const patchSchema = z.object({ enabled: z.boolean() }).strict();

/**
 * Instance settings → Slack: map a channel of any connected Slack workspace to
 * a company and one of its agents. The company doesn't need its own Slack
 * connection; replies go out through the workspace connection.
 */
export function instanceSlackRoutes(db: Db) {
  const router = Router();
  const routes = slackChannelRouteService(db);

  async function connectedWorkspaces() {
    const rows = await db
      .select({
        connectorId: companyConnectors.id,
        companyId: companyConnectors.companyId,
        companyName: companies.name,
        status: companyConnectors.status,
        config: companyConnectors.config,
      })
      .from(companyConnectors)
      .innerJoin(companies, eq(companies.id, companyConnectors.companyId))
      .where(eq(companyConnectors.type, "slack"));
    return rows
      .filter((row) => row.status === "connected")
      .map((row) => {
        const meta = readSlackWorkspaceMetadata(row.config);
        return meta
          ? {
            connectorId: row.connectorId,
            connectedViaCompanyId: row.companyId,
            connectedViaCompanyName: row.companyName,
            workspaceId: meta.workspaceId,
            workspaceName: meta.workspaceName ?? meta.workspaceId,
          }
          : null;
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);
  }

  async function workspaceFor(connectorId: string) {
    const workspace = (await connectedWorkspaces()).find((w) => w.connectorId === connectorId);
    if (!workspace) throw notFound("Slack workspace connection not found or not connected");
    return workspace;
  }

  router.get("/instance/settings/slack", async (req, res) => {
    assertInstanceAdmin(req);
    const [workspaces, all, companyRows] = await Promise.all([
      connectedWorkspaces(),
      routes.listAll(),
      db.select({ id: companies.id, name: companies.name }).from(companies),
    ]);
    const companyName = new Map(companyRows.map((c) => [c.id, c.name]));
    res.json({
      workspaces,
      companies: companyRows.sort((a, b) => a.name.localeCompare(b.name)),
      routes: all.map(({ route, assigneeAgentName }) => ({
        id: route.id,
        connectorId: route.connectorId,
        workspaceId: route.workspaceId,
        channelId: route.channelId,
        channelName: route.channelName,
        companyId: route.companyId,
        companyName: companyName.get(route.companyId) ?? null,
        assigneeAgentId: route.assigneeAgentId,
        assigneeAgentName,
        enabled: route.enabled,
      })),
    });
  });

  router.get("/instance/settings/slack/channels", async (req, res) => {
    assertInstanceAdmin(req);
    const workspace = await workspaceFor(String(req.query.connectorId ?? ""));
    const channels = await listSlackChannels(db, workspace.connectedViaCompanyId);
    res.json({
      channels: channels
        .filter((c) => !c.isPrivate)
        .map((c) => ({ id: c.id, name: c.name, isMember: c.isMember }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  });

  router.get("/instance/settings/slack/companies/:companyId/agents", async (req, res) => {
    assertInstanceAdmin(req);
    const rows = await db
      .select({ id: agents.id, name: agents.name, title: agents.title, status: agents.status })
      .from(agents)
      .where(eq(agents.companyId, req.params.companyId as string));
    res.json({
      agents: rows
        .filter((a) => a.status !== "terminated" && a.status !== "pending_approval")
        .map(({ id, name, title }) => ({ id, name, title }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  });

  router.put("/instance/settings/slack/routes", validate(upsertSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const body = req.body as z.infer<typeof upsertSchema>;
    const workspace = await workspaceFor(body.connectorId);
    const channel = (await listSlackChannels(db, workspace.connectedViaCompanyId)).find((c) => c.id === body.channelId);
    if (!channel || channel.isPrivate) throw unprocessable("Pick a public Slack channel");
    if (!channel.isMember) {
      throw unprocessable(`Invite the Agent Studio bot to #${channel.name} first (type /invite @<bot name> in the channel)`);
    }
    const route = await routes.upsert({
      companyId: body.companyId,
      connectorId: workspace.connectorId,
      workspaceId: workspace.workspaceId,
      channelId: channel.id,
      channelName: channel.name,
      assigneeAgentId: body.assigneeAgentId,
      enabled: body.enabled,
      createdByUserId: req.actor.userId ?? null,
      allowMoveCompany: true,
    });
    res.json(route);
  });

  router.patch("/instance/settings/slack/routes/:id", validate(patchSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const existing = (await routes.listAll()).find(({ route }) => route.id === req.params.id);
    if (!existing) throw notFound("Slack channel mapping not found");
    const { route } = existing;
    const updated = await routes.upsert({
      companyId: route.companyId,
      connectorId: route.connectorId,
      workspaceId: route.workspaceId,
      channelId: route.channelId,
      channelName: route.channelName,
      assigneeAgentId: route.assigneeAgentId,
      enabled: req.body.enabled,
      createdByUserId: req.actor.userId ?? null,
    });
    res.json(updated);
  });

  router.delete("/instance/settings/slack/routes/:id", async (req, res) => {
    assertInstanceAdmin(req);
    const removed = await routes.removeById(req.params.id as string, req.actor.userId ?? null);
    if (!removed) throw notFound("Slack channel mapping not found");
    res.json({ success: true });
  });

  return router;
}
