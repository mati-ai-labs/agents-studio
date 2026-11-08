import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueComments, issues, slackChannelRoutes, slackEventDeliveries, slackThreadBindings } from "@paperclipai/db";
import { heartbeatService } from "./heartbeat.js";
import { issueService } from "./issues.js";
import { logActivity } from "./activity-log.js";
import { enqueueSlackOutbound } from "./slack-outbound-dispatch.js";
import { buildSlackAckMessage, buildSlackErrorMessage } from "./slack-message-builder.js";
import { ingestSlackIssue, slackAssigneeName } from "./slack-issue-ingest.js";
import { getSlackUserName } from "./slack.js";

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

  /** Cancel the issue's running execution, if any. Returns the cancelled run id. */
  async function interruptActiveIssueRun(
    issue: typeof issues.$inferSelect,
    context: { bindingId: string; commentId: string; slackEventId: string; slackUserId: string },
  ): Promise<string | null> {
    try {
      let run = issue.executionRunId ? await heartbeat.getRun(issue.executionRunId) : null;
      if ((!run || run.status !== "running") && issue.assigneeAgentId) {
        const active = await heartbeat.getActiveRunForAgent(issue.assigneeAgentId);
        const snapshot = active?.contextSnapshot as Record<string, unknown> | null | undefined;
        if (active && active.status === "running" && snapshot?.issueId === issue.id) run = active;
      }
      if (!run || run.status !== "running") return null;
      const cancelled = await heartbeat.cancelRun(run.id, "Interrupted by Slack thread reply", {
        errorCode: "operator_interrupted",
        resultJson: { operatorInterrupted: true, interruptionSource: "slack_thread_reply", interruptedIssueId: issue.id, slackUserId: context.slackUserId },
        eventMessage: "run interrupted by Slack thread reply",
        eventPayload: { issueId: issue.id, source: "slack_thread_reply", slackEventId: context.slackEventId },
      });
      if (!cancelled) return null;
      await logActivity(db, { companyId: issue.companyId, actorType: "system", actorId: "slack", action: "heartbeat.cancelled", entityType: "heartbeat_run", entityId: cancelled.id, details: { agentId: cancelled.agentId, source: "slack_thread_reply", issueId: issue.id, bindingId: context.bindingId, commentId: context.commentId, cancellationKind: "operator_interrupted" } });
      return cancelled.id;
    } catch {
      // Never let an interrupt failure drop the reply; the wake below still queues it.
      return null;
    }
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
    const authorName = (await getSlackUserName(db, binding.companyId, event.userId, { channelId: event.channelId })) ?? event.userId;
    const comment = await db.transaction(async (tx) => {
      if (reopened) await tx.update(issues).set({ status: "todo", completedAt: null, cancelledAt: null, updatedAt: new Date() }).where(eq(issues.id, issue.id));
      const [created] = await tx.insert(issueComments).values({ companyId: binding.companyId, issueId: issue.id, authorType: "system", authorAgentId: null, authorUserId: null, body: `From Slack user ${authorName}:\n${event.text}`.slice(0, 30_000), externalSource: "slack", externalId, externalAuthorId: event.userId }).onConflictDoNothing().returning();
      await tx.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, issue.id));
      await tx.update(slackThreadBindings).set({ lastInboundAt: new Date(), updatedAt: new Date() }).where(eq(slackThreadBindings.id, binding.id));
      return created;
    });
    if (!comment) return process(await db.select().from(slackEventDeliveries).where(eq(slackEventDeliveries.id, delivery.id)).then((rows) => rows[0] ?? delivery));
    await mark(delivery.id, { status: "succeeded", processedAt: new Date(), companyId: binding.companyId, bindingId: binding.id, issueId: issue.id, commentId: comment.id });
    await logActivity(db, { companyId: binding.companyId, actorType: "system", actorId: "slack", action: "slack.comment_ingested", entityType: "issue", entityId: issue.id, details: { bindingId: binding.id, commentId: comment.id } });
    if (issue.assigneeAgentId) {
      // A Slack thread reply interrupts the issue's in-flight execution (like a
      // board "interrupt" comment) so the agent picks the reply up right away
      // instead of it waiting in the queue behind the current run.
      const interruptedRunId = await interruptActiveIssueRun(issue, { bindingId: binding.id, commentId: comment.id, slackEventId: event.eventId, slackUserId: event.userId });
      void heartbeat.wakeup(issue.assigneeAgentId, { source: "automation", triggerDetail: "system", reason: reopened ? "issue_reopened_via_slack" : "issue_commented", payload: { issueId: issue.id, commentId: comment.id, bindingId: binding.id, slackEventId: event.eventId, mutation: "slack_comment", ...(interruptedRunId ? { interruptedRunId } : {}) }, requestedByActorType: "system", requestedByActorId: "slack", contextSnapshot: { issueId: issue.id, taskId: issue.id, commentId: comment.id, wakeCommentId: comment.id, source: reopened ? "slack.comment.reopen" : "slack.comment", wakeReason: reopened ? "issue_reopened_via_slack" : "issue_commented", ...(interruptedRunId ? { interruptedRunId } : {}), slackThread: { workspaceId: event.workspaceId, channelId: event.channelId, threadTs: event.threadTs } } }).catch(() => {});
    }
    else await enqueueSlackOutbound(db, { companyId: binding.companyId, connectorId: binding.connectorId, issueId: issue.id, bindingId: binding.id, commentId: comment.id, kind: "error", dedupeKey: `error:event:${event.eventId}`, channelId: binding.channelId, threadTs: binding.threadTs, payload: { text: buildSlackErrorMessage("The Paperclip issue is currently unassigned.") } });
  }

  return { process };
}
