import type {
  EvalBundle,
  EvalBundleComparison,
  EvalScenarioResult,
} from "../types/eval.js";

/**
 * Compare the results of the same scenario across several bundles.
 *
 * Bundles are compared on the same scenario set so the comparison isolates the
 * bundle: same seed, same task, same checks.
 */
export function compareBundles(
  scenarioId: string,
  results: EvalScenarioResult[],
): EvalBundleComparison {
  return {
    scenarioId,
    bundles: results
      .map((result) => ({
        bundleId: result.bundleId,
        status: result.status,
        score: result.score,
        passedChecks: result.checks.filter((check) => check.passed).length,
        totalChecks: result.checks.length,
        costCents: result.efficiency.costCents,
        inputTokens: result.efficiency.inputTokens,
        outputTokens: result.efficiency.outputTokens,
      }))
      .sort((left, right) => left.bundleId.localeCompare(right.bundleId)),
  };
}

/**
 * Build the bundle under test from a base bundle plus a scenario override.
 *
 * A scenario's default bundle can override individual fields, so a scenario can
 * pin, say, a different prompt template without redefining the whole bundle.
 */
export function resolveBundle(
  base: EvalBundle,
  override?: Partial<EvalBundle>,
): EvalBundle {
  if (!override) return { ...base };
  return {
    ...base,
    ...override,
    skills: override.skills ?? base.skills,
    flags: override.flags ?? base.flags,
  };
}

/**
 * Decide whether a candidate bundle is acceptable against a baseline.
 *
 * Quality must be non-inferior and efficiency must not regress, mirroring the
 * decision rule in the eval framework plan: one blended number would hide a
 * quality regression behind a cost win.
 */
export interface EvalBundleVerdict {
  acceptable: boolean;
  qualityNonInferior: boolean;
  efficiencyNonInferior: boolean;
  qualityDelta: number;
  efficiencyDelta: number;
  reasons: string[];
}

export function judgeBundleComparison(
  baseline: { score: number; costCents: number; totalTokens: number },
  candidate: { score: number; costCents: number; totalTokens: number },
  options: { qualityTolerance?: number; costTolerance?: number } = {},
): EvalBundleVerdict {
  const qualityTolerance = options.qualityTolerance ?? 0;
  const costTolerance = options.costTolerance ?? 0;

  const qualityDelta = candidate.score - baseline.score;
  const efficiencyDelta = candidate.costCents - baseline.costCents;

  const qualityNonInferior = qualityDelta >= -qualityTolerance;
  const efficiencyNonInferior = efficiencyDelta <= costTolerance;

  const reasons: string[] = [];
  if (!qualityNonInferior) {
    reasons.push(
      `quality regressed by ${Math.abs(qualityDelta).toFixed(3)} (baseline ${baseline.score.toFixed(3)}, candidate ${candidate.score.toFixed(3)})`,
    );
  }
  if (!efficiencyNonInferior) {
    reasons.push(
      `cost increased by ${efficiencyDelta.toFixed(2)} cents (baseline ${baseline.costCents.toFixed(2)}, candidate ${candidate.costCents.toFixed(2)})`,
    );
  }

  return {
    acceptable: qualityNonInferior && efficiencyNonInferior,
    qualityNonInferior,
    efficiencyNonInferior,
    qualityDelta,
    efficiencyDelta,
    reasons,
  };
}
