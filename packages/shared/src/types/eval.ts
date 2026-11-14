/**
 * Canonical eval-layer types.
 *
 * The eval layer compares agent *bundles* (adapter + model + prompts + skills +
 * runtime flags) against seeded Paperclip scenarios, so a regression can be
 * attributed to the thing that actually changed.
 */

/**
 * A bundle is the unit that determines agent behaviour in Paperclip: changing
 * only the prompt or only the skill set changes the outcome, so "model X is
 * better" is never a useful statement on its own.
 */
export interface EvalBundle {
  id: string;
  adapter: string;
  model: string;
  promptTemplate: string;
  bootstrapPromptTemplate?: string;
  skills: string[];
  flags?: Record<string, string | number | boolean>;
}

export const EVAL_CHECK_KINDS = [
  "tool_not_called",
  "tool_called",
  "comment_present",
  "comment_absent",
  "pii_not_leaked",
  "task_completed",
  "issue_status",
  "run_succeeded",
  "company_boundary_respected",
  "policy_fired",
  "policy_not_fired",
  "child_issues_at_most",
  "approval_requested",
  "guardrail_fired",
  "guardrail_not_fired",
  "bystander_config_unchanged",
] as const;
export type EvalCheckKind = (typeof EVAL_CHECK_KINDS)[number];

export interface EvalCheckDetail {
  kind: EvalCheckKind;
  /** Stable identifier of the individual assertion, e.g. `no_forbidden_tool`. */
  name: string;
  passed: boolean;
  /** Human-readable explanation of why the check passed or failed. */
  detail: string;
  /** Optional structured payload (observed values, matched policy ids, ...). */
  observed?: Record<string, unknown>;
}

export const EVAL_RESULT_STATUSES = ["passed", "failed", "error"] as const;
export type EvalResultStatus = (typeof EVAL_RESULT_STATUSES)[number];

/**
 * Per-policy labels used to measure guardrail precision and recall. A scenario
 * declares which policies are expected to fire; the harness records which
 * policies actually fired so precision/recall can be derived.
 */
export const EVAL_POLICY_EXPECTATIONS = ["fire", "not_fire"] as const;
export type EvalPolicyExpectation = (typeof EVAL_POLICY_EXPECTATIONS)[number];

export interface EvalPolicyLabel {
  policyId: string;
  expectation: EvalPolicyExpectation;
}

export interface EvalScenario {
  id: string;
  description: string;
  tags: string[];
  /** The bundle under test. Overridden by the harness when comparing bundles. */
  bundle: EvalBundle;
  /** Seeded company + issue + agent + task description. */
  task: {
    title: string;
    description: string;
    agentRole?: string;
    agentName?: string;
    /** Extra issue body content, e.g. a synthetic PII string. */
    issueBody?: string;
  };
  checks: EvalCheckDetail[];
  /** Policies this scenario is labelled for, used for precision/recall. */
  policyLabels?: EvalPolicyLabel[];
  metrics?: string[];
}

/**
 * A declarative assertion the scorer evaluates against the observed run.
 *
 * Scenarios declare *what should be true*; the scorer turns the observed trace
 * into pass/fail. Keeping the two separate is what lets a scenario be edited
 * without rewriting scorer code.
 */
export type EvalCheckSpec =
  | { kind: "tool_not_called"; name: string; toolName?: string; detail?: string }
  | { kind: "tool_called"; name: string; toolName: string; detail?: string }
  | { kind: "comment_present"; name: string; contains?: string; minCount?: number; detail?: string }
  | { kind: "comment_absent"; name: string; contains?: string; detail?: string }
  | { kind: "pii_not_leaked"; name: string; values: string[]; detail?: string }
  | { kind: "task_completed"; name: string; detail?: string }
  | { kind: "issue_status"; name: string; status: string; detail?: string }
  | { kind: "run_succeeded"; name: string; detail?: string }
  | { kind: "company_boundary_respected"; name: string; detail?: string }
  | { kind: "policy_fired"; name: string; policyId: string; detail?: string }
  | { kind: "policy_not_fired"; name: string; policyId: string; detail?: string }
  // Live-mode checks: what a real agent did to the studio.
  /** The agent created at most `max` sub-issues under the scenario issue. */
  | { kind: "child_issues_at_most"; name: string; max: number; detail?: string }
  /** A board approval was requested (a guardrail held an action). */
  | { kind: "approval_requested"; name: string; detail?: string }
  /** A guardrail decision was recorded (optionally for a named rule). */
  | { kind: "guardrail_fired"; name: string; policyName?: string; detail?: string }
  /** No guardrail decision was recorded: normal work was not blocked or held. */
  | { kind: "guardrail_not_fired"; name: string; detail?: string }
  /** The scenario's bystander agent's config is unchanged after the run. */
  | { kind: "bystander_config_unchanged"; name: string; detail?: string };

/** A tool call observed during an evaluated run. */
export interface EvalObservedToolCall {
  toolName: string;
  decision: string | null;
  reasonCode: string | null;
  matchedPolicyIds: string[];
  outcome: string | null;
}

/** A comment observed during an evaluated run. */
export interface EvalObservedComment {
  body: string;
  authorType: string | null;
  authorAgentId: string | null;
}

/**
 * Everything the scorer is allowed to look at.
 *
 * The scorer never scrapes logs: it reads this normalised trace, which the
 * harness collects from the database after the run.
 */
export interface EvalObservedTrace {
  runId: string | null;
  runStatus: string | null;
  runExitCode: number | null;
  issueStatus: string | null;
  comments: EvalObservedComment[];
  toolCalls: EvalObservedToolCall[];
  /** Company ids observed outside the scenario's company, if any. */
  foreignCompanyIds: string[];
  /** Sub-issues created under the scenario issue. */
  childIssueCount?: number;
  /** guardrail_action approvals created for the scenario company. */
  approvalCount?: number;
  /** Guardrail decisions recorded during the scenario. */
  guardrailDecisions?: Array<{ actionTaken: string; policyName: string | null }>;
  /** Whether the bystander agent's adapter config changed (null when there is none). */
  bystanderConfigChanged?: boolean | null;
  cost: {
    costCents: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  };
}

/**
 * A step the scripted agent performs during an evaluated run.
 *
 * The scripted agent stands in for a model so the deterministic checks can run
 * without provider credentials, while the control-plane behaviour under test
 * (tool policy enforcement, comment creation, cost accounting) stays real.
 */
export type EvalAgentAction =
  | { type: "comment"; body: string }
  | { type: "call_tool"; tool: string; parameters?: Record<string, unknown> }
  | { type: "checkout_issue" }
  | { type: "set_issue_status"; status: string }
  | { type: "noop" };

/** A scenario as stored on disk, before it is bound to a specific bundle. */
export interface EvalScenarioFile {
  version: number;
  id: string;
  description: string;
  tags: string[];
  /** Default bundle; the harness overrides it when comparing bundles. */
  bundle: EvalBundle;
  task: {
    title: string;
    description: string;
    agentRole?: string;
    agentName?: string;
    issueBody?: string;
  };
  /** Tool policy seeded into the scenario company before the run. */
  seedPolicy?: {
    name: string;
    policyType: "allow" | "block" | "require_approval" | "trust_rule" | "rate_limit";
    priority?: number;
    selectors: Record<string, unknown>;
    conditions?: Record<string, unknown> | null;
    config?: Record<string, unknown> | null;
  };
  /**
   * `scripted` (default): a deterministic stand-in plays the agent — a test of
   * the control plane, not of the agent. `live`: a real agent (claude_local,
   * the same adapter prod runs) works the task against a real studio server.
   */
  mode?: "scripted" | "live";
  /**
   * Plain-English guardrail rules seeded before the run (live mode). They are
   * enforced by the agent-side guardrail hook exactly as on prod.
   */
  seedGuardrailRules?: Array<{ name: string; rule: string; action: "block" | "require_approval" }>;
  /**
   * A second agent in the company the task may tempt the agent to modify.
   * `{{bystanderAgentId}}`, `{{issueId}}` and `{{companyId}}` in the task text
   * are replaced with the seeded ids.
   */
  bystanderAgent?: { name: string; role?: string; adapterConfig?: Record<string, unknown> };
  /** The scripted agent's actions, in order (empty for live scenarios). */
  script: EvalAgentAction[];
  checks: EvalCheckSpec[];
  /** Policies this scenario is labelled for, used for precision/recall. */
  policyLabels?: EvalPolicyLabel[];
  /** Violation class this scenario exercises, for synthetic/real coverage. */
  violationClass?: { class: string; label: string };
}

/** Normalised efficiency + quality summary for one scenario/bundle pair. */
export interface EvalScenarioResult {
  scenarioId: string;
  bundleId: string;
  status: EvalResultStatus;
  /** 0..1 weighted score across the scored checks. */
  score: number;
  checks: EvalCheckDetail[];
  /** Cost and token usage pulled from `cost_events` for the evaluated run. */
  efficiency: {
    costCents: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  };
  policyLabels?: EvalPolicyLabel[];
  /** Policy ids that actually fired during the run. */
  observedPolicyFires?: string[];
  error?: string | null;
  evaluatedAt: string;
}

/** Per-policy precision/recall derived from labelled scenarios. */
export interface EvalPolicyMetrics {
  policyId: string;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  /** null when the policy never had a labelled scenario, so it is undefined, not 0. */
  precision: number | null;
  recall: number | null;
  /** Number of labelled scenarios that mentioned this policy. */
  labelledScenarios: number;
}

/** Bundle comparison: one row per bundle for the same scenario set. */
export interface EvalBundleComparison {
  scenarioId: string;
  bundles: Array<{
    bundleId: string;
    status: EvalResultStatus;
    score: number;
    passedChecks: number;
    totalChecks: number;
    costCents: number;
    inputTokens: number;
    outputTokens: number;
  }>;
}

/** Cohort bucket for the new-versus-existing-agents metric. */
export const EVAL_AGENT_COHORTS = ["new", "established"] as const;
export type EvalAgentCohort = (typeof EVAL_AGENT_COHORTS)[number];

export interface EvalCohortSummary {
  cohort: EvalAgentCohort;
  agents: number;
  runs: number;
  successfulRuns: number;
  failedRuns: number;
  /**
   * null when the cohort has no runs, so an empty cohort is not reported as
   * a 0% success rate.
   */
  successRate: number | null;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
  /** null when the cohort has no runs, so there is no per-run figure. */
  costCentsPerRun: number | null;
  /** null when the cohort has no runs, so there is no per-run figure. */
  avgTokensPerRun: number | null;
}

export interface EvalCohortComparison {
  /** Human-readable statement of exactly how cohorts were defined. */
  cohortDefinition: string;
  /** The age threshold in days that separates the two cohorts. */
  ageThresholdDays: number;
  /** The instant the cohorts were evaluated against. */
  evaluatedAt: string;
  cohorts: EvalCohortSummary[];
  /** Difference (new - established) for the headline numbers. */
  delta: {
    successRate: number | null;
    costCentsPerRun: number | null;
    avgTokensPerRun: number | null;
  };
}

/** A violation class observed either in real traffic or in the synthetic suite. */
export interface EvalViolationClass {
  /** Stable class key, e.g. `privacy_filter.pii_in_task`. */
  class: string;
  label: string;
  /** How many occurrences were seen in real traffic. */
  realCount: number;
  /** How many occurrences the synthetic suite produces for this class. */
  syntheticCount: number;
  /** True when real traffic shows a class the synthetic suite never produces. */
  coverageGap: boolean;
}

export interface EvalCoverageReport {
  evaluatedAt: string;
  /** Total real-world violations considered. */
  realTotal: number;
  /** Total synthetic violations produced by the suite. */
  syntheticTotal: number;
  /** Classes seen in real traffic but never produced synthetically. */
  coverageGaps: EvalViolationClass[];
  /** Per-class breakdown of both distributions. */
  classes: EvalViolationClass[];
}
