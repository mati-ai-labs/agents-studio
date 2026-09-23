import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  authUsers,
  issueCompletionDeliveries,
  issues,
  heartbeatRuns,
  projects,
} from "@paperclipai/db";
import type {
  IssueCompletionDeliverySummary,
  IssueCompletionDestination,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { buildHeartbeatRunIssueComment } from "./heartbeat-run-summary.js";
import { SlackApiError, postSlackMessage } from "./slack.js";

const DELIVERY_LEASE_MS = 2 * 60 * 1_000;
const DELIVERY_MAX_ATTEMPTS = 8;
const DESCRIPTION_EXCERPT_MAX_CHARS = 280;
const COMMENT_EXCERPT_MAX_CHARS = 280;
const MAX_CHILD_SUMMARIES = 5;

type IssueCompletionDeliveryRow = typeof issueCompletionDeliveries.$inferSelect;

type SlackCompletionPayloadRecord = {
  provider: "slack";
  text: string;
  blocks: Array<Record<string, unknown>>;
  completedAt: string | null;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeWhitespace(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function truncateInlineText(value: string | null | undefined, maxChars: number): string | null {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return null;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function escapeSlackMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function formatSlackDate(date: Date): string {
  const unixSeconds = Math.floor(date.getTime() / 1_000);
  return `<!date^${unixSeconds}^{date_short_pretty} at {time}|${date.toISOString()}>`;
}

function parsePayload(value: unknown): SlackCompletionPayloadRecord | null {
  if (!isObjectRecord(value)) return null;
  if (value.provider !== "slack") return null;
  const text = readTrimmedString(value.text);
  const blocks = Array.isArray(value.blocks)
    ? value.blocks.filter((entry): entry is Record<string, unknown> => isObjectRecord(entry))
    : [];
  const completedAt = typeof value.completedAt === "string" || value.completedAt === null
    ? value.completedAt
    : null;
  if (!text) return null;
  return {
    provider: "slack",
    text,
    blocks,
    completedAt,
  };
}

function summarizeIssueCompletionDelivery(row: IssueCompletionDeliveryRow): IssueCompletionDeliverySummary {
  return {
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    sourceActivityId: row.sourceActivityId,
    status: row.status,
    destination: row.destination,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt,
    lastAttemptAt: row.lastAttemptAt,
    deliveredAt: row.deliveredAt,
    lastError: row.lastError,
    providerMessageId: row.providerMessageId,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function computeRetryDelayMs(attemptCount: number, retryAfterMs?: number): number {
  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return retryAfterMs;
  }
  const backoffMs = 60_000 * 2 ** Math.max(0, attemptCount - 1);
  return Math.min(backoffMs, 60 * 60 * 1_000);
}

function completedAtMatches(snapshotCompletedAt: Date | null, currentCompletedAt: Date | null): boolean {
  if (!snapshotCompletedAt && !currentCompletedAt) return true;
  if (!snapshotCompletedAt || !currentCompletedAt) return false;
  return snapshotCompletedAt.getTime() === currentCompletedAt.getTime();
}

function buildCompletionTransitionKey(
  issueId: string,
  completedAt: Date | null,
  sourceActivityId: string,
): string {
  return completedAt
    ? `${issueId}:${completedAt.toISOString()}`
    : `${issueId}:activity:${sourceActivityId}`;
}

async function buildSlackCompletionPayload(
  db: Db,
  issueId: string,
): Promise<{
  companyId: string;
  completedAt: Date | null;
  destination: IssueCompletionDestination;
  payload: SlackCompletionPayloadRecord;
} | null> {
  const issue = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      title: issues.title,
      description: issues.description,
      status: issues.status,
      completedAt: issues.completedAt,
      completionDestination: issues.completionDestination,
      projectId: issues.projectId,
      projectName: projects.name,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeAgentName: agents.name,
      assigneeUserId: issues.assigneeUserId,
      assigneeUserName: authUsers.name,
      assigneeUserEmail: authUsers.email,
    })
    .from(issues)
    .leftJoin(projects, eq(issues.projectId, projects.id))
    .leftJoin(agents, eq(issues.assigneeAgentId, agents.id))
    .leftJoin(authUsers, eq(issues.assigneeUserId, authUsers.id))
    .where(eq(issues.id, issueId))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!issue || issue.status !== "done" || !issue.completionDestination) return null;

  const latestFinishedRun = await db
    .select({
      resultJson: heartbeatRuns.resultJson,
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, issue.companyId),
      sql<boolean>`(
        ${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}
        or ${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${issue.id}
      )`,
      sql<boolean>`${heartbeatRuns.finishedAt} is not null`,
    ))
    .orderBy(desc(heartbeatRuns.finishedAt), desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  const childIssues = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
    })
    .from(issues)
    .where(and(
      eq(issues.companyId, issue.companyId),
      eq(issues.parentId, issue.id),
      inArray(issues.status, ["done", "cancelled"]),
    ))
    .orderBy(asc(issues.issueNumber), asc(issues.createdAt), asc(issues.id))
    .limit(MAX_CHILD_SUMMARIES);

  const issueLabel = issue.identifier ?? "Issue";
  const escapedTitle = escapeSlackMrkdwn(issue.title);
  const descriptionExcerpt = truncateInlineText(issue.description, DESCRIPTION_EXCERPT_MAX_CHARS);
  const completionSummary = truncateInlineText(
    buildHeartbeatRunIssueComment(latestFinishedRun?.resultJson),
    COMMENT_EXCERPT_MAX_CHARS,
  );
  const assigneeLabel = issue.assigneeAgentName
    ?? issue.assigneeUserName
    ?? issue.assigneeUserEmail
    ?? "Unassigned";
  const contextBits = [
    issue.projectName ? `Project *${escapeSlackMrkdwn(issue.projectName)}*` : null,
    `Assignee *${escapeSlackMrkdwn(assigneeLabel)}*`,
    issue.completedAt ? `Completed ${formatSlackDate(issue.completedAt)}` : null,
  ].filter((entry): entry is string => Boolean(entry));

  const childLines = childIssues.map((child) => {
    const childPrefix = child.identifier ? `${child.identifier} ` : "";
    return `• *${escapeSlackMrkdwn(`${childPrefix}${child.title}`)}*`;
  });

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:white_check_mark: *${escapeSlackMrkdwn(issueLabel)} completed*\n${escapedTitle}`,
      },
    },
  ];

  if (contextBits.length > 0) {
    blocks.push({
      type: "context",
      elements: contextBits.map((text) => ({ type: "mrkdwn", text })),
    });
  }

  if (descriptionExcerpt) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Description*\n${escapeSlackMrkdwn(descriptionExcerpt)}`,
      },
    });
  }

  if (completionSummary) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Completion summary*\n${escapeSlackMrkdwn(completionSummary)}`,
      },
    });
  }

  if (childLines.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Completed child issues*\n${childLines.join("\n")}`,
      },
    });
  }

  const text = [
    `${issueLabel} completed: ${issue.title}`,
    issue.projectName ? `Project: ${issue.projectName}` : null,
    `Assignee: ${assigneeLabel}`,
    issue.completedAt ? `Completed: ${issue.completedAt.toISOString()}` : null,
    completionSummary ? `Completion summary: ${completionSummary}` : null,
  ].filter((entry): entry is string => Boolean(entry)).join(" | ");

  return {
    companyId: issue.companyId,
    completedAt: issue.completedAt,
    destination: issue.completionDestination,
    payload: {
      provider: "slack",
      text,
      blocks,
      completedAt: issue.completedAt?.toISOString() ?? null,
    },
  };
}

export interface EnqueueIssueCompletionDeliveryInput {
  issueId: string;
  sourceActivityId: string;
}

export interface ProcessIssueCompletionDeliveriesResult {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  superseded: number;
}

export function issueCompletionDeliveryService(db: Db) {
  async function getLatestByIssueIds(issueIds: string[]): Promise<Map<string, IssueCompletionDeliverySummary>> {
    const uniqueIssueIds = [...new Set(issueIds)];
    const map = new Map<string, IssueCompletionDeliverySummary>();
    if (uniqueIssueIds.length === 0) return map;

    for (const chunkStart of Array.from({ length: Math.ceil(uniqueIssueIds.length / 200) }, (_, index) => index * 200)) {
      const issueIdChunk = uniqueIssueIds.slice(chunkStart, chunkStart + 200);
      const rows = await db
        .selectDistinctOn([issueCompletionDeliveries.issueId])
        .from(issueCompletionDeliveries)
        .where(inArray(issueCompletionDeliveries.issueId, issueIdChunk))
        .orderBy(
          issueCompletionDeliveries.issueId,
          desc(issueCompletionDeliveries.createdAt),
          desc(issueCompletionDeliveries.id),
        );
      for (const row of rows) {
        map.set(row.issueId, summarizeIssueCompletionDelivery(row));
      }
    }

    return map;
  }

  async function enqueueForIssueCompletion(
    input: EnqueueIssueCompletionDeliveryInput,
  ): Promise<IssueCompletionDeliverySummary | null> {
    const snapshot = await buildSlackCompletionPayload(db, input.issueId);
    if (!snapshot) return null;
    const completionTransitionKey = buildCompletionTransitionKey(
      input.issueId,
      snapshot.completedAt,
      input.sourceActivityId,
    );

    const inserted = await db
      .insert(issueCompletionDeliveries)
      .values({
        companyId: snapshot.companyId,
        issueId: input.issueId,
        sourceActivityId: input.sourceActivityId,
        completionTransitionKey,
        status: "pending",
        destination: snapshot.destination,
        payload: snapshot.payload,
        completedAt: snapshot.completedAt,
        nextAttemptAt: new Date(),
      })
      .onConflictDoNothing({
        target: [issueCompletionDeliveries.issueId, issueCompletionDeliveries.completionTransitionKey],
      })
      .returning()
      .then((rows) => rows[0] ?? null);

    if (inserted) return summarizeIssueCompletionDelivery(inserted);

    const existing = await db
      .select()
      .from(issueCompletionDeliveries)
      .where(and(
        eq(issueCompletionDeliveries.issueId, input.issueId),
        eq(issueCompletionDeliveries.completionTransitionKey, completionTransitionKey),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return existing ? summarizeIssueCompletionDelivery(existing) : null;
  }

  async function processDueDeliveries(limit = 10): Promise<ProcessIssueCompletionDeliveriesResult> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + DELIVERY_LEASE_MS);
    const nowIso = now.toISOString();
    const leaseExpiresAtIso = leaseExpiresAt.toISOString();
    const claimedRows = Array.from(await db.execute(sql<IssueCompletionDeliveryRow>`
      with due as (
        select id
        from issue_completion_deliveries
        where status in ('pending', 'sending')
          and next_attempt_at <= ${nowIso}
          and (lease_expires_at is null or lease_expires_at <= ${nowIso})
        order by next_attempt_at asc, created_at asc, id asc
        limit ${limit}
        for update skip locked
      )
      update issue_completion_deliveries delivery
      set
        status = 'sending',
        leased_at = ${nowIso},
        lease_expires_at = ${leaseExpiresAtIso},
        lease_token = md5(random()::text || clock_timestamp()::text || delivery.id::text),
        updated_at = ${nowIso}
      from due
      where delivery.id = due.id
      returning
        delivery.id as "id",
        delivery.company_id as "companyId",
        delivery.issue_id as "issueId",
        delivery.source_activity_id as "sourceActivityId",
        delivery.completion_transition_key as "completionTransitionKey",
        delivery.status as "status",
        delivery.destination as "destination",
        delivery.payload as "payload",
        delivery.attempt_count as "attemptCount",
        delivery.next_attempt_at as "nextAttemptAt",
        delivery.last_attempt_at as "lastAttemptAt",
        delivery.leased_at as "leasedAt",
        delivery.lease_expires_at as "leaseExpiresAt",
        delivery.lease_token as "leaseToken",
        delivery.delivered_at as "deliveredAt",
        delivery.provider_message_id as "providerMessageId",
        delivery.last_error as "lastError",
        delivery.completed_at as "completedAt",
        delivery.created_at as "createdAt",
        delivery.updated_at as "updatedAt"
    `)) as IssueCompletionDeliveryRow[];

    const result: ProcessIssueCompletionDeliveriesResult = {
      claimed: claimedRows.length,
      sent: 0,
      retried: 0,
      failed: 0,
      superseded: 0,
    };

    for (const row of claimedRows) {
      const leaseToken = row.leaseToken;
      if (!leaseToken) continue;

      const currentIssue = await db
        .select({
          status: issues.status,
          completedAt: issues.completedAt,
        })
        .from(issues)
        .where(eq(issues.id, row.issueId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!currentIssue || currentIssue.status !== "done" || !completedAtMatches(row.completedAt, currentIssue.completedAt)) {
        await db
          .update(issueCompletionDeliveries)
          .set({
            status: "superseded",
            leaseToken: null,
            leasedAt: null,
            leaseExpiresAt: null,
            updatedAt: new Date(),
          })
          .where(and(
            eq(issueCompletionDeliveries.id, row.id),
            eq(issueCompletionDeliveries.leaseToken, leaseToken),
          ));
        result.superseded += 1;
        continue;
      }

      const payload = parsePayload(row.payload);
      if (!payload) {
        await db
          .update(issueCompletionDeliveries)
          .set({
            status: "failed",
            attemptCount: row.attemptCount + 1,
            lastAttemptAt: now,
            lastError: "Stored Slack payload is invalid",
            leaseToken: null,
            leasedAt: null,
            leaseExpiresAt: null,
            updatedAt: new Date(),
          })
          .where(and(
            eq(issueCompletionDeliveries.id, row.id),
            eq(issueCompletionDeliveries.leaseToken, leaseToken),
          ));
        result.failed += 1;
        continue;
      }

      try {
        const sent = await postSlackMessage(db, row.companyId, {
          channelId: row.destination.channelId,
          text: payload.text,
          blocks: payload.blocks,
        });

        // Slack accepted the message. If the process crashes before the row is
        // committed below, the lease will eventually expire and the sender may
        // post this completion again on retry. We keep that duplicate window
        // explicit here because Slack does not offer an idempotency key for
        // chat.postMessage.
        await db
          .update(issueCompletionDeliveries)
          .set({
            status: "sent",
            attemptCount: row.attemptCount + 1,
            lastAttemptAt: now,
            deliveredAt: new Date(),
            lastError: null,
            providerMessageId: sent.messageTs,
            leaseToken: null,
            leasedAt: null,
            leaseExpiresAt: null,
            updatedAt: new Date(),
          })
          .where(and(
            eq(issueCompletionDeliveries.id, row.id),
            eq(issueCompletionDeliveries.leaseToken, leaseToken),
          ));
        result.sent += 1;
      } catch (error) {
        const attemptCount = row.attemptCount + 1;
        const slackError = error instanceof SlackApiError ? error : null;
        const retryable = slackError?.retryable ?? false;
        if (retryable && attemptCount < DELIVERY_MAX_ATTEMPTS) {
          await db
            .update(issueCompletionDeliveries)
            .set({
              status: "pending",
              attemptCount,
              lastAttemptAt: now,
              nextAttemptAt: new Date(now.getTime() + computeRetryDelayMs(attemptCount, slackError?.retryAfterMs)),
              lastError: error instanceof Error ? error.message : "Slack delivery failed",
              leaseToken: null,
              leasedAt: null,
              leaseExpiresAt: null,
              updatedAt: new Date(),
            })
            .where(and(
              eq(issueCompletionDeliveries.id, row.id),
              eq(issueCompletionDeliveries.leaseToken, leaseToken),
            ));
          result.retried += 1;
          logger.warn(
            {
              deliveryId: row.id,
              issueId: row.issueId,
              attemptCount,
              error: error instanceof Error ? error.message : String(error),
            },
            "retrying issue completion Slack delivery",
          );
          continue;
        }

        await db
          .update(issueCompletionDeliveries)
          .set({
            status: "failed",
            attemptCount,
            lastAttemptAt: now,
            lastError: error instanceof Error ? error.message : "Slack delivery failed",
            leaseToken: null,
            leasedAt: null,
            leaseExpiresAt: null,
            updatedAt: new Date(),
          })
          .where(and(
            eq(issueCompletionDeliveries.id, row.id),
            eq(issueCompletionDeliveries.leaseToken, leaseToken),
          ));
        result.failed += 1;
        logger.error(
          {
            deliveryId: row.id,
            issueId: row.issueId,
            attemptCount,
            error: error instanceof Error ? error.message : String(error),
          },
          "issue completion Slack delivery failed",
        );
      }
    }

    return result;
  }

  return {
    enqueueForIssueCompletion,
    getLatestByIssueIds,
    processDueDeliveries,
    summarizeIssueCompletionDelivery,
  };
}
