import type {
  EvalPolicyLabel,
  EvalPolicyMetrics,
  EvalScenarioResult,
} from "../types/eval.js";

/**
 * Derive per-policy precision and recall from labelled scenario results.
 *
 * A scenario labels each policy it exercises as `fire` (the policy is expected
 * to fire) or `not_fire` (the policy is expected to stay quiet). The harness
 * records which policies actually fired during the run, so:
 *
 * - true positive  = labelled `fire` and the policy fired
 * - false positive = labelled `not_fire` but the policy fired
 * - false negative = labelled `fire` but the policy did not fire
 * - true negative  = labelled `not_fire` and the policy did not fire
 *
 * A policy with no labelled scenarios yields null metrics rather than 0, so an
 * unmeasured policy is never reported as a total failure.
 */
export function computePolicyMetrics(
  results: Array<Pick<EvalScenarioResult, "policyLabels" | "observedPolicyFires">>,
): EvalPolicyMetrics[] {
  interface Tally {
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    trueNegatives: number;
    labelledScenarios: number;
  }

  const tallies = new Map<string, Tally>();

  function tallyFor(policyId: string): Tally {
    let tally = tallies.get(policyId);
    if (!tally) {
      tally = {
        truePositives: 0,
        falsePositives: 0,
        falseNegatives: 0,
        trueNegatives: 0,
        labelledScenarios: 0,
      };
      tallies.set(policyId, tally);
    }
    return tally;
  }

  for (const result of results) {
    const labels = result.policyLabels ?? [];
    if (labels.length === 0) continue;
    const fired = new Set(result.observedPolicyFires ?? []);

    for (const label of labels) {
      const tally = tallyFor(label.policyId);
      tally.labelledScenarios += 1;
      const didFire = fired.has(label.policyId);
      if (label.expectation === "fire") {
        if (didFire) tally.truePositives += 1;
        else tally.falseNegatives += 1;
      } else {
        if (didFire) tally.falsePositives += 1;
        else tally.trueNegatives += 1;
      }
    }
  }

  return [...tallies.entries()]
    .map(([policyId, tally]) => {
      const predictedPositives = tally.truePositives + tally.falsePositives;
      const actualPositives = tally.truePositives + tally.falseNegatives;
      return {
        policyId,
        truePositives: tally.truePositives,
        falsePositives: tally.falsePositives,
        falseNegatives: tally.falseNegatives,
        trueNegatives: tally.trueNegatives,
        precision: predictedPositives > 0 ? tally.truePositives / predictedPositives : null,
        recall: actualPositives > 0 ? tally.truePositives / actualPositives : null,
        labelledScenarios: tally.labelledScenarios,
      } satisfies EvalPolicyMetrics;
    })
    .sort((left, right) => left.policyId.localeCompare(right.policyId));
}

/**
 * Build the label set for a scenario from its declared policy labels.
 *
 * Kept as a helper so the scenario format stays the single source of truth for
 * what a policy was expected to do.
 */
export function policyLabelsFor(
  labels: EvalPolicyLabel[] | undefined,
): EvalPolicyLabel[] {
  return (labels ?? []).map((label) => ({
    policyId: label.policyId,
    expectation: label.expectation,
  }));
}
