import type {
  EvalAgentCohort,
  EvalCohortComparison,
  EvalCohortSummary,
} from "../types/eval.js";

export const DEFAULT_NEW_AGENT_THRESHOLD_DAYS = 30;

/** The cohort definition, stated verbatim in the metric output. */
export function describeCohortDefinition(thresholdDays: number): string {
  return (
    `Agents are bucketed by age at evaluation time: "new" = created less than ` +
    `${thresholdDays} days ago, "established" = created ${thresholdDays} days ago or more. ` +
    `Runs and costs are attributed to an agent's cohort using the agent's created_at, ` +
    `not the run timestamp, so a newly-created agent is compared against its peers ` +
    `rather than against itself as it ages.`
  );
}

/**
 * Bucket an agent by how long ago it was created.
 *
 * The comparison is made at a fixed evaluation instant so that cohort
 * membership does not change mid-report.
 */
export function cohortForAgentAge(
  agentCreatedAt: Date | string | number,
  evaluatedAt: Date | string | number,
  thresholdDays: number = DEFAULT_NEW_AGENT_THRESHOLD_DAYS,
): EvalAgentCohort {
  const created = toTimestamp(agentCreatedAt);
  const now = toTimestamp(evaluatedAt);
  const ageMs = now - created;
  // A future created_at (clock skew) is treated as brand new rather than
  // silently bucketed as established, which would overstate the baseline.
  if (!Number.isFinite(ageMs) || ageMs < 0) return "new";
  return ageMs < thresholdDays * 24 * 60 * 60 * 1000 ? "new" : "established";
}

function toTimestamp(value: Date | string | number): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return new Date(value).getTime();
}

export interface EvalCohortInput {
  agentId: string;
  agentCreatedAt: Date | string;
  runs: number;
  successfulRuns: number;
  failedRuns: number;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Aggregate per-agent history into the two cohorts.
 *
 * The summary deliberately keeps quality (success rate) and efficiency (cost and
 * tokens per run) separate rather than blending them into one number.
 */
export function summarizeCohorts(
  inputs: EvalCohortInput[],
  evaluatedAt: Date | string | number,
  thresholdDays: number = DEFAULT_NEW_AGENT_THRESHOLD_DAYS,
): EvalCohortComparison {
  const now = toTimestamp(evaluatedAt);
  const buckets: Record<EvalAgentCohort, EvalCohortInput[]> = { new: [], established: [] };

  for (const input of inputs) {
    buckets[cohortForAgentAge(input.agentCreatedAt, now, thresholdDays)].push(input);
  }

  const cohorts: EvalCohortSummary[] = (["new", "established"] as EvalAgentCohort[]).map(
    (cohort) => summarizeBucket(cohort, buckets[cohort]),
  );

  const newCohort = cohorts.find((c) => c.cohort === "new");
  const establishedCohort = cohorts.find((c) => c.cohort === "established");

  return {
    cohortDefinition: describeCohortDefinition(thresholdDays),
    ageThresholdDays: thresholdDays,
    evaluatedAt: new Date(now).toISOString(),
    cohorts,
    delta: {
      successRate: difference(newCohort?.successRate ?? null, establishedCohort?.successRate ?? null),
      costCentsPerRun: difference(
        newCohort?.costCentsPerRun ?? null,
        establishedCohort?.costCentsPerRun ?? null,
      ),
      avgTokensPerRun: difference(
        newCohort?.avgTokensPerRun ?? null,
        establishedCohort?.avgTokensPerRun ?? null,
      ),
    },
  };
}

function summarizeBucket(
  cohort: EvalAgentCohort,
  inputs: EvalCohortInput[],
): EvalCohortSummary {
  const runs = inputs.reduce((sum, input) => sum + input.runs, 0);
  const successfulRuns = inputs.reduce((sum, input) => sum + input.successfulRuns, 0);
  const failedRuns = inputs.reduce((sum, input) => sum + input.failedRuns, 0);
  const costCents = inputs.reduce((sum, input) => sum + input.costCents, 0);
  const inputTokens = inputs.reduce((sum, input) => sum + input.inputTokens, 0);
  const outputTokens = inputs.reduce((sum, input) => sum + input.outputTokens, 0);

  return {
    cohort,
    agents: inputs.length,
    runs,
    successfulRuns,
    failedRuns,
    // A cohort with no runs has no success rate and no per-run figures.
    // Reporting 0 would make an empty cohort look like a cohort that ran and
    // failed everything, and would turn the new-vs-established delta into a
    // comparison against a synthetic zero.
    successRate: runs > 0 ? successfulRuns / runs : null,
    costCents,
    inputTokens,
    outputTokens,
    costCentsPerRun: runs > 0 ? costCents / runs : null,
    avgTokensPerRun: runs > 0 ? (inputTokens + outputTokens) / runs : null,
  };
}

function difference(left: number | null, right: number | null): number | null {
  if (left === null || right === null) return null;
  return left - right;
}
