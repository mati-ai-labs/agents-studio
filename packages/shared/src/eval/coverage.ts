import type {
  EvalCoverageReport,
  EvalViolationClass,
} from "../types/eval.js";

export interface EvalViolationObservation {
  /** Stable class key, e.g. `privacy_filter.pii_in_task`. */
  class: string;
  label: string;
  count: number;
}

/**
 * Derive the violation classes the synthetic suite is able to produce.
 *
 * Each scenario declares the violation class it exercises, so the suite itself
 * is the record of what it can reproduce. The count is the number of scenarios
 * that exercise the class, so a class covered by three scenarios is not
 * mistaken for one that is covered once.
 */
export function syntheticViolationClasses(
  scenarios: Array<{ violationClass?: { class?: string; label?: string } | null }>,
): EvalViolationObservation[] {
  const counts = new Map<string, EvalViolationObservation>();

  for (const scenario of scenarios) {
    const violationClass = scenario.violationClass;
    if (!violationClass?.class) continue;
    const existing = counts.get(violationClass.class);
    counts.set(violationClass.class, {
      class: violationClass.class,
      label: violationClass.label ?? violationClass.class,
      count: (existing?.count ?? 0) + 1,
    });
  }

  return [...counts.values()].sort((left, right) => left.class.localeCompare(right.class));
}

/**
 * Compare the distribution of real-world violations against the synthetic
 * baseline.
 *
 * A violation class that appears in real traffic but is never produced by the
 * synthetic suite is a *coverage gap*: the suite cannot catch that regression
 * class, so the gap is reported explicitly rather than silently ignored.
 */
export function buildCoverageReport(
  realViolations: EvalViolationObservation[],
  syntheticViolations: EvalViolationObservation[],
  evaluatedAt: Date | string = new Date(),
): EvalCoverageReport {
  const realByClass = new Map<string, EvalViolationObservation>();
  for (const observation of realViolations) {
    const existing = realByClass.get(observation.class);
    realByClass.set(observation.class, {
      class: observation.class,
      label: observation.label,
      count: (existing?.count ?? 0) + observation.count,
    });
  }

  const syntheticByClass = new Map<string, EvalViolationObservation>();
  for (const observation of syntheticViolations) {
    const existing = syntheticByClass.get(observation.class);
    syntheticByClass.set(observation.class, {
      class: observation.class,
      label: observation.label,
      count: (existing?.count ?? 0) + observation.count,
    });
  }

  const classKeys = [...new Set([...realByClass.keys(), ...syntheticByClass.keys()])].sort();

  const classes: EvalViolationClass[] = classKeys.map((classKey) => {
    const real = realByClass.get(classKey);
    const synthetic = syntheticByClass.get(classKey);
    const realCount = real?.count ?? 0;
    const syntheticCount = synthetic?.count ?? 0;
    return {
      class: classKey,
      label: real?.label ?? synthetic?.label ?? classKey,
      realCount,
      syntheticCount,
      // A gap only exists when the suite cannot reproduce a class seen in real
      // traffic. A synthetic-only class is not a gap; it is an unused fixture.
      coverageGap: realCount > 0 && syntheticCount === 0,
    };
  });

  const coverageGaps = classes.filter((entry) => entry.coverageGap);

  const timestamp =
    evaluatedAt instanceof Date ? evaluatedAt.toISOString() : new Date(evaluatedAt).toISOString();

  return {
    evaluatedAt: timestamp,
    realTotal: classes.reduce((sum, entry) => sum + entry.realCount, 0),
    syntheticTotal: classes.reduce((sum, entry) => sum + entry.syntheticCount, 0),
    coverageGaps,
    classes,
  };
}
