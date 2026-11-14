/**
 * Eval layer service.
 *
 * The eval layer answers two questions the rest of the studio does not:
 *
 *   1. Is this bundle of agent configuration (adapter + model + prompts +
 *      skills + flags) better or worse than another bundle on the same
 *      scenarios? See `evals/` for the scenario definitions and the runner.
 *   2. How do newly-created agents compare against established ones, and
 *      which real-world failure classes does the synthetic suite fail to
 *      reproduce? See `cohortComparison` and `coverageReport` below.
 *
 * The comparison is deliberately stored with the bundle that produced it:
 * a score is only meaningful next to the configuration that earned it.
 */
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  costEvents,
  evalResults,
  heartbeatRuns,
  issueComments,
  toolCallEvents,
} from "@paperclipai/db";
import {
  buildCoverageReport,
  computePolicyMetrics,
  DEFAULT_NEW_AGENT_THRESHOLD_DAYS,
  detectPii,
  PII_VIOLATION_CLASS,
  summarizeCohorts,
  type EvalBundle,
  type EvalCheckDetail,
  type EvalCohortComparison,
  type EvalCohortInput,
  type EvalCoverageReport,
  type EvalPolicyLabel,
  type EvalPolicyMetrics,
  type EvalResultStatus,
  type EvalScenarioResult,
  type EvalViolationObservation,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

export interface EvalResultInput {
  companyId: string;
  scenarioId: string;
  scenarioVersion?: string;
  bundleId: string;
  /** The bundle that produced the score, stored alongside it. */
  bundle: EvalBundle;
  status: EvalResultStatus;
  score: number;
  checks: EvalCheckDetail[];
  costCents?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  heartbeatRunId?: string | null;
  observedPolicyFires?: string[];
  policyLabels?: EvalPolicyLabel[];
  error?: string | null;
  evaluatedAt?: Date;
}

export interface EvalDateRange {
  from?: Date;
  to?: Date;
}

/**
 * The run statuses that count as a successful run for the cohort metric.
 *
 * A run that ended in `failed` or `canceled` is not evidence that the agent
 * was incapable — the request may have been withdrawn. Only the terminal
 * statuses that represent the agent actually attempting the work are counted,
 * and they are counted separately from the failures.
 */
const SUCCESSFUL_RUN_STATUSES = ["succeeded", "completed"] as const;

export function evalService(db: Db) {
  const log = logger.child({ service: "evals" });

  /**
   * Records one scenario/bundle evaluation.
   */
  async function recordResult(input: EvalResultInput) {
    const evaluatedAt = input.evaluatedAt ?? new Date();
    const [row] = await db
      .insert(evalResults)
      .values({
        companyId: input.companyId,
        scenarioId: input.scenarioId,
        scenarioVersion: input.scenarioVersion ?? "1",
        bundleId: input.bundleId,
        bundle: input.bundle,
        status: input.status,
        score: input.score,
        checks: input.checks,
        costCents: input.costCents ?? 0,
        inputTokens: input.inputTokens ?? 0,
        outputTokens: input.outputTokens ?? 0,
        cachedInputTokens: input.cachedInputTokens ?? 0,
        heartbeatRunId: input.heartbeatRunId ?? null,
        observedPolicyFires: input.observedPolicyFires ?? [],
        policyLabels: (input.policyLabels ?? []) as never,
        error: input.error ?? null,
        evaluatedAt,
      })
      .returning();

    log.info(
      { scenarioId: input.scenarioId, bundleId: input.bundleId, status: input.status },
      "recorded eval result",
    );
    return row!;
  }

  /**
   * Lists the stored results for a company, newest first.
   */
  async function listResults(
    companyId: string,
    options: { scenarioId?: string; bundleId?: string; limit?: number } = {},
  ) {
    const conditions = [eq(evalResults.companyId, companyId)];
    if (options.scenarioId) conditions.push(eq(evalResults.scenarioId, options.scenarioId));
    if (options.bundleId) conditions.push(eq(evalResults.bundleId, options.bundleId));

    return db
      .select()
      .from(evalResults)
      .where(and(...conditions))
      .orderBy(desc(evalResults.evaluatedAt))
      .limit(options.limit ?? 200);
  }

  /**
   * Per-policy precision and recall across the labelled results of a company.
   *
   * A policy with no labelled scenario produces no row, so an unmeasured
   * policy is never reported as a total failure.
   */
  async function policyMetrics(
    companyId: string,
    options: { scenarioId?: string; bundleId?: string } = {},
  ): Promise<EvalPolicyMetrics[]> {
    const rows = await listResults(companyId, options);
    return computePolicyMetrics(
      rows.map((row) => ({
        policyLabels: (row.policyLabels ?? []) as EvalPolicyLabel[],
        observedPolicyFires: (row.observedPolicyFires ?? []) as string[],
      })),
    );
  }

  /**
   * Compares newly-created agents against established ones.
   *
   * An agent is bucketed by its `created_at`, not by the run timestamp, so a
   * newly-hired agent is compared against its peers rather than against
   * itself as it ages. A run and its cost are attributed to the cohort the
   * agent belonged to when the run happened.
   */
  async function cohortComparison(
    companyId: string,
    options: { thresholdDays?: number; evaluatedAt?: Date; range?: EvalDateRange } = {},
  ): Promise<EvalCohortComparison> {
    const evaluatedAt = options.evaluatedAt ?? new Date();
    const thresholdDays = options.thresholdDays ?? DEFAULT_NEW_AGENT_THRESHOLD_DAYS;

    const runConditions = [eq(heartbeatRuns.companyId, companyId)];
    if (options.range?.from) runConditions.push(gte(heartbeatRuns.startedAt, options.range.from));
    if (options.range?.to) runConditions.push(lte(heartbeatRuns.startedAt, options.range.to));

    // Every agent of the company is loaded, not only the agents that have run:
    // an agent that has not been woken yet is still a member of its cohort, and
    // leaving it out would understate the cohort's size.
    const agentRows = await db
      .select({ id: agents.id, createdAt: agents.createdAt })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    const runRows = await db
      .select({
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        agentCreatedAt: agents.createdAt,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(and(...runConditions));

    const costConditions = [eq(costEvents.companyId, companyId)];
    if (options.range?.from) costConditions.push(gte(costEvents.occurredAt, options.range.from));
    if (options.range?.to) costConditions.push(lte(costEvents.occurredAt, options.range.to));

    const costRows = await db
      .select({
        agentId: costEvents.agentId,
        costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
        inputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::double precision`,
        outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::double precision`,
      })
      .from(costEvents)
      .where(and(...costConditions))
      .groupBy(costEvents.agentId);

    // Fold the agents, the runs and the costs into one row per agent, so a
    // cohort member with no cost events still contributes its run counts, and
    // an agent that has not run yet still counts towards the cohort's size.
    const perAgent = new Map<string, EvalCohortInput>();

    for (const row of agentRows) {
      perAgent.set(row.id, {
        agentId: row.id,
        agentCreatedAt: row.createdAt,
        runs: 0,
        successfulRuns: 0,
        failedRuns: 0,
        costCents: 0,
        inputTokens: 0,
        outputTokens: 0,
      });
    }

    for (const row of runRows) {
      const entry = perAgent.get(row.agentId) ?? {
        agentId: row.agentId,
        agentCreatedAt: row.agentCreatedAt,
        runs: 0,
        successfulRuns: 0,
        failedRuns: 0,
        costCents: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      entry.runs += 1;
      if (isSuccessfulRun(row.status)) entry.successfulRuns += 1;
      else entry.failedRuns += 1;
      perAgent.set(row.agentId, entry);
    }

    for (const row of costRows) {
      const entry = perAgent.get(row.agentId);
      if (!entry) continue;
      entry.costCents += row.costCents;
      entry.inputTokens += row.inputTokens;
      entry.outputTokens += row.outputTokens;
    }

    return summarizeCohorts([...perAgent.values()], evaluatedAt, thresholdDays);
  }

  /**
   * Compares the real-world failure distribution against the synthetic suite.
   *
   * Real violations are read from the two places the studio actually records
   * them:
   *
   *   - `issue_comments`: a comment an agent posted that carries a sensitive
   *     value. This is the privacy-filter failure.
   *   - `tool_call_events`: a tool call the policy engine did not simply
   *     allow. This is the restricted-action failure.
   *
   * A class that appears in real traffic but that the synthetic suite never
   * produces is a coverage gap: the suite cannot catch that regression, so it
   * is reported explicitly rather than silently ignored.
   */
  async function coverageReport(
    companyId: string,
    synthetic: EvalViolationObservation[],
    options: { range?: EvalDateRange; evaluatedAt?: Date } = {},
  ): Promise<EvalCoverageReport> {
    const commentConditions = [eq(issueComments.companyId, companyId)];
    if (options.range?.from) commentConditions.push(gte(issueComments.createdAt, options.range.from));
    if (options.range?.to) commentConditions.push(lte(issueComments.createdAt, options.range.to));

    const commentRows = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(and(...commentConditions));

    const real: EvalViolationObservation[] = [];

    // A leak is counted once per leaked value, not once per comment, so the
    // synthetic and the real distributions count the same thing.
    let leakedValues = 0;
    for (const row of commentRows) {
      leakedValues += detectPii(row.body).length;
    }
    if (leakedValues > 0) {
      real.push({
        class: PII_VIOLATION_CLASS,
        label: "A sensitive value from the task was echoed into an agent comment",
        count: leakedValues,
      });
    }

    const toolConditions = [eq(toolCallEvents.companyId, companyId)];
    if (options.range?.from) toolConditions.push(gte(toolCallEvents.createdAt, options.range.from));
    if (options.range?.to) toolConditions.push(lte(toolCallEvents.createdAt, options.range.to));

    const toolRows = await db
      .select({
        decision: toolCallEvents.decision,
        count: sql<number>`count(*)::int`,
      })
      .from(toolCallEvents)
      .where(and(...toolConditions))
      .groupBy(toolCallEvents.decision);

    for (const row of toolRows) {
      const classKey = restrictedActionClassFor(row.decision);
      if (!classKey) continue;
      const existing = real.find((entry) => entry.class === classKey);
      if (existing) {
        existing.count += row.count;
        continue;
      }
      real.push({ class: classKey, label: restrictedActionLabel(classKey), count: row.count });
    }

    return buildCoverageReport(real, synthetic, options.evaluatedAt ?? new Date());
  }

  return {
    recordResult,
    listResults,
    policyMetrics,
    cohortComparison,
    coverageReport,
  };
}

/**
 * The restricted-action class a tool-call decision is counted under.
 *
 * Only the decisions that represent the agent being held back are counted: a
 * call the policy engine allowed is not a violation, but a denial, an approval
 * requirement and a rate limit are each a distinct failure mode the synthetic
 * suite may or may not cover.
 */
function restrictedActionClassFor(decision: string | null): string | null {
  switch (decision) {
    case "deny":
      return "restricted_action.blocked_write";
    case "require_approval":
      return "restricted_action.require_approval";
    case "rate_limited":
      return "restricted_action.rate_limited";
    default:
      return null;
  }
}

function restrictedActionLabel(classKey: string): string {
  switch (classKey) {
    case "restricted_action.blocked_write":
      return "A side-effecting tool blocked by policy was attempted";
    case "restricted_action.require_approval":
      return "A tool call was held back pending approval";
    case "restricted_action.rate_limited":
      return "A tool call was held back by a rate limit";
    default:
      return classKey;
  }
}

/**
 * Whether a run status counts as a successful run.
 */
export function isSuccessfulRun(status: string): boolean {
  return (SUCCESSFUL_RUN_STATUSES as readonly string[]).includes(status);
}
