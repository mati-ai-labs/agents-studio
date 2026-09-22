import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  assets,
  issueAttachments,
  issueComments,
  issues,
  routineResultDeliveries,
  routineRuns,
} from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { logger } from "../middleware/logger.js";

const DELIVERY_LEASE_MS = 2 * 60 * 1_000;
const DELIVERY_MAX_ATTEMPTS = 8;

type RoutineResultDeliveryRow = typeof routineResultDeliveries.$inferSelect;

export interface ProcessRoutineResultDeliveriesResult {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
}

function retryDelayMs(attemptCount: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attemptCount - 1), 30 * 60 * 1_000);
}

async function streamToBuffer(stream: AsyncIterable<Uint8Array | Buffer | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function buildRelayComment(input: {
  deliveryId: string;
  executionIssue: { identifier: string | null; title: string; status: string };
  latestOutput: string | null;
  copiedAttachmentCount: number;
}) {
  const executionLabel = input.executionIssue.identifier
    ? `${input.executionIssue.identifier} — ${input.executionIssue.title}`
    : input.executionIssue.title;
  const resultHeading = input.executionIssue.status === "done"
    ? "## Routine result received"
    : "## Routine execution did not complete";
  const statusLine = input.executionIssue.status === "done"
    ? `The independent routine execution **${executionLabel}** completed. Its outputs are now attached to this issue.`
    : `The independent routine execution **${executionLabel}** ended as **${input.executionIssue.status}**. Any partial outputs are attached below.`;
  const output = input.latestOutput?.trim()
    ? `\n\n### Execution output\n\n${input.latestOutput.trim()}`
    : "\n\nNo execution comment was recorded. Review the linked routine execution for run details.";
  const artifactLine = input.copiedAttachmentCount > 0
    ? `\n\n${input.copiedAttachmentCount} artifact${input.copiedAttachmentCount === 1 ? "" : "s"} copied to Outputs.`
    : "\n\nNo artifacts were attached by the routine execution.";
  // The marker makes the relay auditable without coupling the issues in the
  // hierarchy or relying on a parent-child handoff.
  return `${resultHeading}\n\n${statusLine}${output}${artifactLine}\n\n<!-- routine-result-delivery:${input.deliveryId} -->`;
}

/**
 * Queue a completion relay for a webhook run that supplied source_issue_id.
 * The unique run key makes repeated terminal-status sync calls idempotent.
 */
export async function enqueueRoutineResultDelivery(
  db: Db,
  input: { routineRunId: string; executionIssueId: string },
): Promise<RoutineResultDeliveryRow | null> {
  const run = await db
    .select({ companyId: routineRuns.companyId, callbackIssueId: routineRuns.callbackIssueId })
    .from(routineRuns)
    .where(eq(routineRuns.id, input.routineRunId))
    .then((rows) => rows[0] ?? null);
  if (!run?.callbackIssueId) return null;

  const inserted = await db
    .insert(routineResultDeliveries)
    .values({
      companyId: run.companyId,
      routineRunId: input.routineRunId,
      sourceIssueId: run.callbackIssueId,
      executionIssueId: input.executionIssueId,
      status: "pending",
      nextAttemptAt: new Date(),
    })
    .onConflictDoNothing({ target: routineResultDeliveries.routineRunId })
    .returning()
    .then((rows) => rows[0] ?? null);
  if (inserted) return inserted;

  return db
    .select()
    .from(routineResultDeliveries)
    .where(eq(routineResultDeliveries.routineRunId, input.routineRunId))
    .then((rows) => rows[0] ?? null);
}

export function routineResultDeliveryService(db: Db, storage: StorageService) {
  async function processDueDeliveries(limit = 10): Promise<ProcessRoutineResultDeliveriesResult> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + DELIVERY_LEASE_MS);
    const nowIso = now.toISOString();
    const leaseExpiresAtIso = leaseExpiresAt.toISOString();
    const claimedRows = Array.from(await db.execute(sql<RoutineResultDeliveryRow>`
      with due as (
        select id
        from routine_result_deliveries
        where status in ('pending', 'sending')
          and next_attempt_at <= ${nowIso}
          and (lease_expires_at is null or lease_expires_at <= ${nowIso})
        order by next_attempt_at asc, created_at asc, id asc
        limit ${Math.max(1, Math.min(limit, 50))}
        for update skip locked
      )
      update routine_result_deliveries delivery
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
        delivery.routine_run_id as "routineRunId",
        delivery.source_issue_id as "sourceIssueId",
        delivery.execution_issue_id as "executionIssueId",
        delivery.status as "status",
        delivery.attempt_count as "attemptCount",
        delivery.next_attempt_at as "nextAttemptAt",
        delivery.last_attempt_at as "lastAttemptAt",
        delivery.leased_at as "leasedAt",
        delivery.lease_expires_at as "leaseExpiresAt",
        delivery.lease_token as "leaseToken",
        delivery.delivered_at as "deliveredAt",
        delivery.last_error as "lastError",
        delivery.created_at as "createdAt",
        delivery.updated_at as "updatedAt"
    `)) as RoutineResultDeliveryRow[];

    const result: ProcessRoutineResultDeliveriesResult = {
      claimed: claimedRows.length,
      sent: 0,
      retried: 0,
      failed: 0,
    };

    for (const delivery of claimedRows) {
      const leaseToken = delivery.leaseToken;
      if (!leaseToken) continue;

      try {
        const [sourceIssue, executionIssue] = await Promise.all([
          db
            .select({ id: issues.id, companyId: issues.companyId })
            .from(issues)
            .where(and(eq(issues.id, delivery.sourceIssueId), eq(issues.companyId, delivery.companyId)))
            .then((rows) => rows[0] ?? null),
          db
            .select({
              id: issues.id,
              companyId: issues.companyId,
              identifier: issues.identifier,
              title: issues.title,
              status: issues.status,
              assigneeAgentId: issues.assigneeAgentId,
            })
            .from(issues)
            .where(and(eq(issues.id, delivery.executionIssueId), eq(issues.companyId, delivery.companyId)))
            .then((rows) => rows[0] ?? null),
        ]);
        if (!sourceIssue || !executionIssue) {
          await db
            .update(routineResultDeliveries)
            .set({
              status: "failed",
              attemptCount: delivery.attemptCount + 1,
              lastAttemptAt: now,
              lastError: "Source or execution issue is no longer available",
              leaseToken: null,
              leasedAt: null,
              leaseExpiresAt: null,
              updatedAt: new Date(),
            })
            .where(and(
              eq(routineResultDeliveries.id, delivery.id),
              eq(routineResultDeliveries.leaseToken, leaseToken),
            ));
          result.failed += 1;
          continue;
        }

        const [latestComment, attachments] = await Promise.all([
          db
            .select({ body: issueComments.body })
            .from(issueComments)
            .where(and(eq(issueComments.issueId, executionIssue.id), isNull(issueComments.deletedAt)))
            .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
            .limit(1)
            .then((rows) => rows[0] ?? null),
          db
            .select({
              assetId: assets.id,
              provider: assets.provider,
              objectKey: assets.objectKey,
              contentType: assets.contentType,
              byteSize: assets.byteSize,
              sha256: assets.sha256,
              originalFilename: assets.originalFilename,
              createdByAgentId: assets.createdByAgentId,
              createdByUserId: assets.createdByUserId,
            })
            .from(issueAttachments)
            .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
            .where(and(
              eq(issueAttachments.companyId, delivery.companyId),
              eq(issueAttachments.issueId, executionIssue.id),
            ))
            .orderBy(issueAttachments.createdAt, issueAttachments.id),
        ]);

        const copied = [] as Array<{
          provider: string;
          objectKey: string;
          contentType: string;
          byteSize: number;
          sha256: string;
          originalFilename: string | null;
          createdByAgentId: string | null;
          createdByUserId: string | null;
        }>;
        for (const attachment of attachments) {
          const object = await storage.getObject(delivery.companyId, attachment.objectKey);
          const body = await streamToBuffer(object.stream);
          const stored = await storage.putFile({
            companyId: delivery.companyId,
            namespace: `routine-result-deliveries/${delivery.id}`,
            originalFilename: attachment.originalFilename,
            contentType: attachment.contentType,
            body,
          });
          copied.push({
            ...stored,
            createdByAgentId: attachment.createdByAgentId,
            createdByUserId: attachment.createdByUserId,
          });
        }

        await db.transaction(async (tx) => {
          const [comment] = await tx
            .insert(issueComments)
            .values({
              companyId: delivery.companyId,
              issueId: sourceIssue.id,
              authorType: "system",
              body: buildRelayComment({
                deliveryId: delivery.id,
                executionIssue,
                latestOutput: latestComment?.body ?? null,
                copiedAttachmentCount: copied.length,
              }),
            })
            .returning();

          if (copied.length > 0) {
            const copiedAssets = await tx
              .insert(assets)
              .values(copied.map((asset) => ({
                companyId: delivery.companyId,
                ...asset,
              })))
              .returning();
            await tx.insert(issueAttachments).values(copiedAssets.map((asset) => ({
              companyId: delivery.companyId,
              issueId: sourceIssue.id,
              assetId: asset.id,
              issueCommentId: comment.id,
            })));
          }

          await tx
            .update(issues)
            .set({ updatedAt: new Date() })
            .where(eq(issues.id, sourceIssue.id));

          await tx
            .update(routineResultDeliveries)
            .set({
              status: "sent",
              attemptCount: delivery.attemptCount + 1,
              lastAttemptAt: now,
              deliveredAt: new Date(),
              lastError: null,
              leaseToken: null,
              leasedAt: null,
              leaseExpiresAt: null,
              updatedAt: new Date(),
            })
            .where(and(
              eq(routineResultDeliveries.id, delivery.id),
              eq(routineResultDeliveries.leaseToken, leaseToken),
            ));
        });
        result.sent += 1;
      } catch (error) {
        const attemptCount = delivery.attemptCount + 1;
        const retry = attemptCount < DELIVERY_MAX_ATTEMPTS;
        await db
          .update(routineResultDeliveries)
          .set({
            status: retry ? "pending" : "failed",
            attemptCount,
            lastAttemptAt: now,
            nextAttemptAt: retry ? new Date(now.getTime() + retryDelayMs(attemptCount)) : delivery.nextAttemptAt,
            lastError: error instanceof Error ? error.message : String(error),
            leaseToken: null,
            leasedAt: null,
            leaseExpiresAt: null,
            updatedAt: new Date(),
          })
          .where(and(
            eq(routineResultDeliveries.id, delivery.id),
            eq(routineResultDeliveries.leaseToken, leaseToken),
          ));
        if (retry) {
          result.retried += 1;
          logger.warn({ err: error, deliveryId: delivery.id }, "routine result relay failed; retry queued");
        } else {
          result.failed += 1;
          logger.error({ err: error, deliveryId: delivery.id }, "routine result relay failed permanently");
        }
      }
    }

    return result;
  }

  return { processDueDeliveries };
}
