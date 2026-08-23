import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueComments, issues, slackChannelRoutes, slackEventDeliveries, slackThreadBindings } from "@paperclipai/db";
import { heartbeatService } from "./heartbeat.js";
import { issueService } from "./issues.js";
import { logActivity } from "./activity-log.js";
import { enqueueSlackOutbound } from "./slack-outbound-dispatch.js";
import { buildSlackAckMessage, buildSlackErrorMessage } from "./slack-message-builder.js";
import { ingestSlackIssue, slackAssigneeName } from "./slack-issue-ingest.js";

export interface SlackInboundHandlerOptions {
  pluginWorkerManager?: unknown;
}

type NormalizedEvent = {
  eventType: "app_mention" | "message.channels";
  eventId: string;
  workspaceId: string;
  userId: string;
  text: string;
  channelId: string;
  channelName?: string;
  ts: string;
  eventTs?: string;
  threadTs?: string | null;
};

function isRootMention(event: NormalizedEvent) {
  return event.eventType === "app_mention" && (!event.threadTs || event.threadTs === event.ts);
}

export function slackInboundHandler(db: Db, options: SlackInboundHandlerOptions = {}) {
  const heartbeat = heartbeatService(db, { pluginWorkerManager: options.pluginWorkerManager as never });

  async function mark(deliveryId: string, values: Partial<typeof slackEventDeliveries.$inferInsert>) {
    await db.update(slackEventDeliveries).set({ ...values, updatedAt: new Date() }).where(eq(slackEventDeliveries.id, deliveryId));
  }

  async function process(delivery: typeof slackEventDeliveries.$inferSelect) {
    const event = delivery.payload as unknown as NormalizedEvent;
    if (!event.userId || !event.channelId || !event.ts) {
      await mark(delivery.id, { status: "ignored", processedAt: new Date(), lastError: "missing normalized event fields" });
      return;
    }
    if (isRootMention(event)) {
      const route = await db.select().from(slackChannelRoutes).where(and(eq(slackChannelRoutes.workspaceId, event.workspaceId), eq(slackChannelRoutes.channelId, event.channelId), eq(slackChannelRoutes.enabled, true))).then((rows) => rows[0] ?? null);
      if (!route) {
        await mark(delivery.id, { status: "ignored", processedAt: new Date(), lastError: "no enabled Slack channel route" });
        return;
      }
      const existingBinding = await db.select().from(slackThreadBindings).where(and(eq(slackThreadBindings.workspaceId, event.workspaceId), eq(slackThreadBindings.channelId, event.channelId), eq(slackThreadBindings.threadTs, event.ts))).then((rows) => rows[0] ?? null);
      if (existingBinding) {
        await mark(delivery.id, { status: "succeeded", processedAt: new Date(), companyId: existingBinding.companyId, bindingId: existingBinding.id, issueId: existingBinding.issueId });
        return;
      }
      const issue = await ingestSlackIssue(db, {
        companyId: route.companyId,
        assigneeAgentId: route.assigneeAgentId,
        workspaceId: event.workspaceId,
        channelId: event.channelId,
        channelName: route.channelName,
        threadTs: event.ts,
        eventId: event.eventId,
        userId: event.userId,
        text: event.text,
      });
      const [binding] = await db.insert(slackThreadBindings).values({ companyId: route.companyId, connectorId: route.connectorId, channelRouteId: route.id, issueId: issue.id, workspaceId: event.workspaceId, channelId: event.channelId, channelName: route.channelName, threadTs: event.ts, rootEventId: event.eventId, rootUserId: event.userId, lastInboundAt: new Date() }).onConflictDoNothing().returning();
      const resolvedBinding = binding ?? await db.select().from(slackThreadBindings).where(and(eq(slackThreadBindings.workspaceId, event.workspaceId), eq(slackThreadBindings.channelId, event.channelId), eq(slackThreadBindings.threadTs, event.ts))).then((rows) => rows[0] ?? null);
      if (!resolvedBinding) throw new Error("Slack thread binding was not created");
      const assigneeName = await slackAssigneeName(db, route.assigneeAgentId);
      await enqueueSlackOutbound(db, { companyId: route.companyId, connectorId: route.connectorId, issueId: issue.id, bindingId: resolvedBinding.id, kind: "acknowledgement", dedupeKey: `ack:binding:${resolvedBinding.id}`, channelId: event.channelId, threadTs: event.ts, payload: { text: buildSlackAckMessage({ ...issue, assigneeName }) } });
      await mark(delivery.id, { status: "succeeded", processedAt: new Date(), companyId: route.companyId, bindingId: resolvedBinding.id, issueId: issue.id });
      await logActivity(db, { companyId: route.companyId, actorType: "system", actorId: "slack", action: "slack.thread_created", entityType: "issue", entityId: issue.id, agentId: route.assigneeAgentId, details: { bindingId: resolvedBinding.id, channelId: event.channelId } });
      void heartbeat.wakeup(route.assigneeAgentId, { source: "assignment", triggerDetail: "system", reason: "slack_thread_created", payload: { issueId: issue.id, bindingId: resolvedBinding.id, slackEventId: event.eventId, mutation: "slack_thread_create" }, requestedByActorType: "system", requestedByActorId: "slack", contextSnapshot: { issueId: issue.id, taskId: issue.id, source: "slack.thread.create", wakeReason: "slack_thread_created", slackThread: { workspaceId: event.workspaceId, channelId: event.channelId, threadTs: event.ts } } }).catch(() => {});
      return;
    }

    if (event.eventType !== "message.channels" || !event.threadTs) {
      await mark(delivery.id, { status: "ignored", processedAt: new Date(), lastError: "unsupported or unbound Slack event" });
      return;
    }
    const binding = await db.select().from(slackThreadBindings).where(and(eq(slackThreadBindings.workspaceId, event.workspaceId), eq(slackThreadBindings.channelId, event.channelId), eq(slackThreadBindings.threadTs, event.threadTs))).then((rows) => rows[0] ?? null);
    if (!binding) {
      await mark(delivery.id, { status: "ignored", processedAt: new Date(), lastError: "Slack thread is not bound" });
      return;
    }
    const externalId = `${event.workspaceId}:${event.channelId}:${event.ts}`;
    const existingComment = await db.select().from(issueComments).where(and(eq(issueComments.companyId, binding.companyId), eq(issueComments.externalSource, "slack"), eq(issueComments.externalId, externalId))).then((rows) => rows[0] ?? null);
    if (existingComment) {
      await mark(delivery.id, { status: "succeeded", processedAt: new Date(), companyId: binding.companyId, bindingId: binding.id, issueId: binding.issueId, commentId: existingComment.id });
      return;
    }
    const issue = await db.select().from(issues).where(and(eq(issues.id, binding.issueId), eq(issues.companyId, binding.companyId))).then((rows) => rows[0] ?? null);
    if (!issue) throw new Error("Slack binding issue no longer exists");
    const reopened = issue.status === "done" || issue.status === "cancelled";
    const comment = await db.transaction(async (tx) => {
      if (reopened) await tx.update(issues).set({ status: "todo", completedAt: null, cancelledAt: null, updatedAt: new Date() }).where(eq(issues.id, issue.id));
      const [created] = await tx.insert(issueComments).values({ companyId: binding.companyId, issueId: issue.id, authorType: "system", authorAgentId: null, authorUserId: null, body: `From Slack user ${event.userId}:\n${event.text}`.slice(0, 30_000), externalSource: "slack", externalId, externalAuthorId: event.userId }).onConflictDoNothing().returning();
      await tx.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, issue.id));
      await tx.update(slackThreadBindings).set({ lastInboundAt: new Date(), updatedAt: new Date() }).where(eq(slackThreadBindings.id, binding.id));
      return created;
    });
    if (!comment) return process(await db.select().from(slackEventDeliveries).where(eq(slackEventDeliveries.id, delivery.id)).then((rows) => rows[0] ?? delivery));
    await mark(delivery.id, { status: "succeeded", processedAt: new Date(), companyId: binding.companyId, bindingId: binding.id, issueId: issue.id, commentId: comment.id });
    await logActivity(db, { companyId: binding.companyId, actorType: "system", actorId: "slack", action: "slack.comment_ingested", entityType: "issue", entityId: issue.id, details: { bindingId: binding.id, commentId: comment.id } });
    if (issue.assigneeAgentId) void heartbeat.wakeup(issue.assigneeAgentId, { source: "automation", triggerDetail: "system", reason: reopened ? "issue_reopened_via_slack" : "issue_commented", payload: { issueId: issue.id, commentId: comment.id, bindingId: binding.id, slackEventId: event.eventId, mutation: "slack_comment" }, requestedByActorType: "system", requestedByActorId: "slack", contextSnapshot: { issueId: issue.id, taskId: issue.id, commentId: comment.id, wakeCommentId: comment.id, source: reopened ? "slack.comment.reopen" : "slack.comment", wakeReason: reopened ? "issue_reopened_via_slack" : "issue_commented", slackThread: { workspaceId: event.workspaceId, channelId: event.channelId, threadTs: event.threadTs } } }).catch(() => {});
    else await enqueueSlackOutbound(db, { companyId: binding.companyId, connectorId: binding.connectorId, issueId: issue.id, bindingId: binding.id, commentId: comment.id, kind: "error", dedupeKey: `error:event:${event.eventId}`, channelId: binding.channelId, threadTs: binding.threadTs, payload: { text: buildSlackErrorMessage("The Paperclip issue is currently unassigned.") } });
  }

  return { process };
}
