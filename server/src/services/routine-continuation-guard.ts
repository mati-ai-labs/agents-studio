import { and, eq, inArray, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { routineResultDeliveries, routineRuns } from "@paperclipai/db";

const ACTIVE_ROUTINE_RUN_STATUSES = ["received", "issue_created"] as const;
const ACTIVE_ROUTINE_DELIVERY_STATUSES = ["pending", "sending"] as const;

/**
 * Return source issues whose callback-linked routine still owns the next
 * continuation. Routine execution issues are intentionally not included:
 * they are linked through routineRuns.linkedIssueId, not callbackIssueId.
 */
export async function listActiveRoutineContinuationIssueIds(
  db: Db,
  input: { companyId?: string | null; issueIds: string[] },
) {
  const issueIds = [...new Set(input.issueIds.filter(Boolean))];
  if (issueIds.length === 0) return new Set<string>();

  const rows = await db
    .select({ callbackIssueId: routineRuns.callbackIssueId })
    .from(routineRuns)
    .leftJoin(
      routineResultDeliveries,
      eq(routineResultDeliveries.routineRunId, routineRuns.id),
    )
    .where(and(
      input.companyId ? eq(routineRuns.companyId, input.companyId) : undefined,
      inArray(routineRuns.callbackIssueId, issueIds),
      or(
        inArray(routineRuns.status, [...ACTIVE_ROUTINE_RUN_STATUSES]),
        inArray(routineResultDeliveries.status, [...ACTIVE_ROUTINE_DELIVERY_STATUSES]),
      ),
    ));

  return new Set(
    rows
      .map((row) => row.callbackIssueId)
      .filter((issueId): issueId is string => Boolean(issueId)),
  );
}

export async function hasActiveRoutineContinuation(
  db: Db,
  input: { companyId: string; issueId: string },
) {
  const issueIds = await listActiveRoutineContinuationIssueIds(db, {
    companyId: input.companyId,
    issueIds: [input.issueId],
  });
  return issueIds.has(input.issueId);
}
