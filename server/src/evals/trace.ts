import { and, eq, inArray } from "drizzle-orm";
import {
  costEvents,
  heartbeatRuns,
  issueComments,
  issues,
  toolCallEvents,
  type Db,
} from "@paperclipai/db";
import type {
  EvalObservedComment,
  EvalObservedToolCall,
  EvalObservedTrace,
} from "@paperclipai/shared";

/**
 * Collect the normalised trace for an evaluated run.
 *
 * The scorer only ever sees this structure, never raw logs, so a scenario's
 * assertions stay stable even when the runtime changes how it logs.
 */
export async function collectTrace(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    runId: string | null;
  },
): Promise<EvalObservedTrace> {
  const { companyId, issueId, runId } = input;

  const issueRow = await db
    .select({ status: issues.status })
    .from(issues)
    .where(eq(issues.id, issueId))
    .then((rows) => rows[0] ?? null);

  const runRow = runId
    ? await db
        .select({
          status: heartbeatRuns.status,
          exitCode: heartbeatRuns.exitCode,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null)
    : null;

  const comments: EvalObservedComment[] = await db
    .select({
      body: issueComments.body,
      authorType: issueComments.authorType,
      authorAgentId: issueComments.authorAgentId,
    })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        eq(issueComments.issueId, issueId),
      ),
    )
    .then((rows) =>
      rows.map((row) => ({
        body: row.body,
        authorType: row.authorType ?? null,
        authorAgentId: row.authorAgentId ?? null,
      })),
    );

  const toolCalls: EvalObservedToolCall[] = runId
    ? await db
        .select({
          toolName: toolCallEvents.toolName,
          decision: toolCallEvents.decision,
          reasonCode: toolCallEvents.reasonCode,
          matchedPolicyIds: toolCallEvents.matchedPolicyIds,
          outcome: toolCallEvents.outcome,
        })
        .from(toolCallEvents)
        .where(
          and(
            eq(toolCallEvents.companyId, companyId),
            eq(toolCallEvents.runId, runId),
          ),
        )
        .then((rows) =>
          rows.map((row) => ({
            toolName: row.toolName ?? "",
            decision: row.decision ?? null,
            reasonCode: row.reasonCode ?? null,
            matchedPolicyIds: row.matchedPolicyIds ?? [],
            outcome: row.outcome ?? null,
          })),
        )
    : [];

  const costRows = runId
    ? await db
        .select({
          costCents: costEvents.costCents,
          inputTokens: costEvents.inputTokens,
          outputTokens: costEvents.outputTokens,
          cachedInputTokens: costEvents.cachedInputTokens,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            eq(costEvents.heartbeatRunId, runId),
          ),
        )
    : [];

  const cost = costRows.reduce(
    (acc, row) => ({
      costCents: acc.costCents + row.costCents,
      inputTokens: acc.inputTokens + row.inputTokens,
      outputTokens: acc.outputTokens + row.outputTokens,
      cachedInputTokens: acc.cachedInputTokens + row.cachedInputTokens,
    }),
    { costCents: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
  );

  return {
    runId,
    runStatus: runRow?.status ?? null,
    runExitCode: runRow?.exitCode ?? null,
    issueStatus: issueRow?.status ?? null,
    comments,
    toolCalls,
    foreignCompanyIds: [],
    cost,
  };
}

/**
 * Find the policy ids that actually fired during a run.
 *
 * A policy "fires" when it appears in a tool call's matched policy ids, which
 * is what the tool access policy engine records for every decision.
 */
export function collectObservedPolicyFires(trace: EvalObservedTrace): string[] {
  const fired = new Set<string>();
  for (const call of trace.toolCalls) {
    for (const policyId of call.matchedPolicyIds) {
      fired.add(policyId);
    }
  }
  return [...fired].sort();
}

/**
 * List the company ids observed in a set of runs.
 *
 * Used to detect a cross-company access: the scenario's own company is
 * excluded, and anything left is a boundary violation.
 */
export async function collectForeignCompanyIds(
  db: Db,
  input: { companyId: string; runIds: string[] },
): Promise<string[]> {
  if (input.runIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ companyId: toolCallEvents.companyId })
    .from(toolCallEvents)
    .where(inArray(toolCallEvents.runId, input.runIds));
  return rows
    .map((row) => row.companyId)
    .filter((companyId) => companyId !== input.companyId);
}
