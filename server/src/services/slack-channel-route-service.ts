import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, slackChannelRoutes } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";

export function slackChannelRouteService(db: Db) {
  async function list(companyId: string, offset = 0, limit = 100) {
    return db.select({ route: slackChannelRoutes, assigneeAgentName: agents.name })
      .from(slackChannelRoutes)
      .leftJoin(agents, eq(agents.id, slackChannelRoutes.assigneeAgentId))
      .where(eq(slackChannelRoutes.companyId, companyId))
      .orderBy(desc(slackChannelRoutes.createdAt)).limit(Math.min(Math.max(limit, 1), 200)).offset(Math.max(offset, 0));
  }

  async function upsert(input: { companyId: string; connectorId: string; workspaceId: string; channelId: string; channelName: string; assigneeAgentId: string; enabled?: boolean; createdByUserId?: string | null }) {
    const agent = await db.select({ id: agents.id, companyId: agents.companyId, status: agents.status }).from(agents).where(eq(agents.id, input.assigneeAgentId)).then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Assignee agent not found");
    if (agent.companyId !== input.companyId) throw unprocessable("Assignee must belong to the same company");
    if (agent.status === "terminated" || agent.status === "pending_approval") throw conflict("Assignee is unavailable");
    const existing = await db.select().from(slackChannelRoutes).where(and(eq(slackChannelRoutes.workspaceId, input.workspaceId), eq(slackChannelRoutes.channelId, input.channelId))).then((rows) => rows[0] ?? null);
    if (existing && existing.companyId !== input.companyId) throw conflict("Slack channel is already routed to another company");
    const [route] = existing
      ? await db.update(slackChannelRoutes).set({ connectorId: input.connectorId, channelName: input.channelName, assigneeAgentId: input.assigneeAgentId, enabled: input.enabled ?? true, updatedAt: new Date() }).where(eq(slackChannelRoutes.id, existing.id)).returning()
      : await db.insert(slackChannelRoutes).values({ companyId: input.companyId, connectorId: input.connectorId, workspaceId: input.workspaceId, channelId: input.channelId, channelName: input.channelName, assigneeAgentId: input.assigneeAgentId, enabled: input.enabled ?? true, createdByUserId: input.createdByUserId ?? null }).returning();
    await logActivity(db, { companyId: input.companyId, actorType: "user", actorId: input.createdByUserId ?? "board", action: "slack.channel_route_upserted", entityType: "slack_channel_route", entityId: route.id, details: { workspaceId: input.workspaceId, channelId: input.channelId, enabled: route.enabled } });
    return route;
  }

  async function remove(companyId: string, channelId: string) {
    const [route] = await db.delete(slackChannelRoutes).where(and(eq(slackChannelRoutes.companyId, companyId), eq(slackChannelRoutes.channelId, channelId))).returning();
    if (!route) return null;
    await logActivity(db, { companyId, actorType: "user", actorId: "board", action: "slack.channel_route_deleted", entityType: "slack_channel_route", entityId: route.id, details: { channelId } });
    return route;
  }
  return { list, upsert, remove };
}
