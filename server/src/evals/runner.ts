import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  costEvents,
  heartbeatRuns,
  instanceSettings,
  issues,
  toolPolicies,
  type Db,
} from "@paperclipai/db";
import {
  evaluateCheck,
  scoreChecks,
  type EvalAgentAction,
  type EvalBundle,
  type EvalCheckDetail,
  type EvalPolicyLabel,
  type EvalScenarioFile,
  type EvalScenarioResult,
} from "@paperclipai/shared";
import { heartbeatService } from "../services/heartbeat.js";
import { evalService } from "../services/evals.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { collectObservedPolicyFires, collectTrace } from "./trace.js";
import { EVAL_SCRIPTED_ADAPTER_TYPE, createScriptedAdapter } from "./scripted-adapter.js";

export interface ScenarioRunOptions {
  db: Db;
  scenario: EvalScenarioFile;
  /** Bundle under test; defaults to the scenario's own bundle. */
  bundle?: EvalBundle;
  /** How long to wait for the heartbeat run to finish. */
  timeoutMs?: number;
  /**
   * The company the scenario is seeded into.
   *
   * A harness run uses one company for every scenario, so the results, the
   * cohort metric and the coverage report all aggregate over the same
   * population instead of being scattered across throwaway companies.
   */
  companyId?: string;
}

export interface ScenarioRun {
  result: EvalScenarioResult;
  /** The ids the run created, so a caller can inspect what was seeded. */
  seeded: { companyId: string; agentId: string; issueId: string; runId: string | null };
  /** Violation class the scenario exercised, for synthetic coverage. */
  violationClass: EvalScenarioFile["violationClass"];
}

/**
 * Create the company every scenario in a harness run shares.
 *
 * One company per run means the eval results, the cohort comparison and the
 * coverage report are all computed over the same population.
 */
export async function createEvalCompany(
  db: Db,
  options: { name?: string } = {},
): Promise<string> {
  const companyId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: options.name ?? "Eval Harness",
    // The prefix is unique per company, and the eval company is synthetic.
    issuePrefix: `EV${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    status: "active",
    requireBoardApprovalForNewAgents: false,
    defaultResponsibleUserId: "eval-responsible-user",
  });
  return companyId;
}

/**
 * Run one scenario end to end.
 *
 * The company, agent and issue are seeded into the same database the rest of
 * the studio uses, the agent is woken exactly as the runtime would wake it,
 * and the resulting trace is scored and written to `eval_results`.
 */
export async function runScenario(options: ScenarioRunOptions): Promise<ScenarioRun> {
  const { db, scenario } = options;
  const bundle = options.bundle ?? scenario.bundle;
  const timeoutMs = options.timeoutMs ?? 30_000;

  const seeded = await seedScenario(db, scenario, bundle, options.companyId);

  const adapter = createScriptedAdapter(db, {
    script: scenario.script,
    issueId: seeded.issueId,
    companyId: seeded.companyId,
  });
  registerServerAdapter(adapter);

  const evaluatedAt = new Date();
  let runId: string | null = null;
  let error: string | null = null;

  try {
    const heartbeat = heartbeatService(db, {
      // The harness runs in-process, so a worktree instance must not suppress
      // the run it is explicitly asked to perform.
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: undefined },
    });

    const run = await heartbeat.invoke(seeded.agentId, "on_demand", { issueId: seeded.issueId }, "manual");
    runId = run?.id ?? null;
    if (!run) {
      throw new Error("the heartbeat did not queue a run for the seeded agent");
    }

    await heartbeat.waitForRunExecutionDrain(run.id, { timeoutMs });
    await heartbeat.drainActiveRunExecutions();

    const finalRun = await heartbeat.getRun(run.id);
    if (finalRun && !["succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(finalRun.status)) {
      throw new Error(`the heartbeat run finished in unexpected status "${finalRun.status}"`);
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    unregisterServerAdapter(EVAL_SCRIPTED_ADAPTER_TYPE);
  }

  const trace = await collectTrace(db, {
    companyId: seeded.companyId,
    issueId: seeded.issueId,
    runId,
  });

  const checks: EvalCheckDetail[] = scenario.checks.map((spec) => evaluateCheck(spec, trace));
  const score = scoreChecks(checks);
  const observedPolicyFires = collectObservedPolicyFires(trace);
  const policyLabels = await resolvePolicyLabels(db, seeded.companyId, scenario.policyLabels);

  const result: EvalScenarioResult = {
    scenarioId: scenario.id,
    bundleId: bundle.id,
    status: error ? "error" : score === 1 ? "passed" : "failed",
    score,
    checks,
    efficiency: {
      costCents: trace.cost.costCents,
      inputTokens: trace.cost.inputTokens,
      outputTokens: trace.cost.outputTokens,
      cachedInputTokens: trace.cost.cachedInputTokens,
    },
    policyLabels,
    observedPolicyFires,
    error,
    evaluatedAt: evaluatedAt.toISOString(),
  };

  return {
    result,
    seeded: { ...seeded, runId },
    violationClass: scenario.violationClass,
  };
}

/**
 * Persist a scenario result to `eval_results`.
 *
 * The stored row carries the bundle that produced the score, so a score is
 * always readable next to the configuration that earned it.
 */
export async function recordScenarioResult(
  db: Db,
  input: {
    companyId: string;
    scenario: EvalScenarioFile;
    bundle: EvalBundle;
    result: EvalScenarioResult;
    runId: string | null;
  },
) {
  return evalService(db).recordResult({
    companyId: input.companyId,
    scenarioId: input.scenario.id,
    scenarioVersion: String(input.scenario.version),
    bundleId: input.bundle.id,
    bundle: input.bundle,
    status: input.result.status,
    score: input.result.score,
    checks: input.result.checks,
    costCents: input.result.efficiency.costCents,
    inputTokens: input.result.efficiency.inputTokens,
    outputTokens: input.result.efficiency.outputTokens,
    cachedInputTokens: input.result.efficiency.cachedInputTokens,
    heartbeatRunId: input.runId,
    observedPolicyFires: input.result.observedPolicyFires ?? [],
    policyLabels: input.result.policyLabels ?? [],
    error: input.result.error ?? null,
    evaluatedAt: new Date(input.result.evaluatedAt),
  });
}

/**
 * Seed the company, agent, issue and any tool policy the scenario needs.
 *
 * The agent, issue and policy are always fresh, so a scenario never observes
 * another scenario's rows. The company is shared when the caller supplies one,
 * which is what lets the results aggregate.
 */
async function seedScenario(
  db: Db,
  scenario: EvalScenarioFile,
  bundle: EvalBundle,
  companyId?: string,
): Promise<{ companyId: string; agentId: string; issueId: string }> {
  const resolvedCompanyId = companyId ?? (await createEvalCompany(db, { name: `Eval ${scenario.id}` }));
  const agentId = randomUUID();
  const issueId = randomUUID();

  await db.insert(agents).values({
    id: agentId,
    companyId: resolvedCompanyId,
    name: scenario.task.agentName ?? `Eval Agent ${scenario.id}`,
    role: scenario.task.agentRole ?? "engineer",
    status: "idle",
    adapterType: EVAL_SCRIPTED_ADAPTER_TYPE,
    adapterConfig: {
      model: bundle.model,
      promptTemplate: bundle.promptTemplate,
      skills: bundle.skills,
      flags: bundle.flags ?? {},
    },
    runtimeConfig: {},
    permissions: {},
  });

  await db.insert(issues).values({
    id: issueId,
    companyId: resolvedCompanyId,
    title: scenario.task.title,
    description: scenario.task.description,
    status: "todo",
    priority: "medium",
    assigneeAgentId: agentId,
  });

  if (scenario.seedPolicy) {
    await db.insert(toolPolicies).values({
      companyId: resolvedCompanyId,
      name: scenario.seedPolicy.name,
      policyType: scenario.seedPolicy.policyType,
      priority: scenario.seedPolicy.priority ?? 100,
      selectors: scenario.seedPolicy.selectors,
      conditions: scenario.seedPolicy.conditions ?? null,
      config: scenario.seedPolicy.config ?? null,
      enabled: true,
    });
  }

  return { companyId: resolvedCompanyId, agentId, issueId };
}

/**
 * Resolve a scenario's policy labels onto the policy ids that actually exist.
 *
 * A scenario labels a policy by the name it seeded it under, because a policy
 * id is a random uuid and would make the scenario file unreviewable. The label
 * is rewritten to the real id before the result is stored, so precision and
 * recall are computed against the policy that really fired.
 */
async function resolvePolicyLabels(
  db: Db,
  companyId: string,
  labels: EvalPolicyLabel[] | undefined,
): Promise<EvalPolicyLabel[]> {
  if (!labels || labels.length === 0) return [];

  const rows = await db
    .select({ id: toolPolicies.id, name: toolPolicies.name })
    .from(toolPolicies)
    .where(eq(toolPolicies.companyId, companyId));

  const byName = new Map(rows.map((row) => [row.name, row.id]));

  const resolved: EvalPolicyLabel[] = [];
  for (const label of labels) {
    if (label.policyId.startsWith("seeded:")) {
      const policyId = byName.get(label.policyId.slice("seeded:".length));
      // A label that cannot be resolved would silently become a false
      // negative, so it is dropped rather than counted against the policy.
      if (!policyId) continue;
      resolved.push({ policyId, expectation: label.expectation });
      continue;
    }
    resolved.push({ policyId: label.policyId, expectation: label.expectation });
  }
  return resolved;
}

/**
 * Read the recorded results for a company, newest first.
 *
 * The harness uses this to prove a score was persisted and is readable back.
 */
export async function readBackResults(
  db: Db,
  companyId: string,
  options: { scenarioId?: string; bundleId?: string } = {},
) {
  return evalService(db).listResults(companyId, options);
}

/**
 * The cost the run actually incurred, read from `cost_events`.
 *
 * The scripted adapter reports a non-zero cost, so this is the same source of
 * truth the cohort metric uses.
 */
export async function readRunCost(db: Db, runId: string) {
  return db
    .select({
      costCents: costEvents.costCents,
      inputTokens: costEvents.inputTokens,
      outputTokens: costEvents.outputTokens,
    })
    .from(costEvents)
    .where(eq(costEvents.heartbeatRunId, runId))
    .then((rows) =>
      rows.reduce(
        (acc, row) => ({
          costCents: acc.costCents + row.costCents,
          inputTokens: acc.inputTokens + row.inputTokens,
          outputTokens: acc.outputTokens + row.outputTokens,
        }),
        { costCents: 0, inputTokens: 0, outputTokens: 0 },
      ),
    );
}

/**
 * Turn the host's scheduling gates off for the duration of a harness run.
 *
 * The gates exist to protect a production host that spawns a CLI process tree
 * per run. The scripted adapter spawns nothing, so the gates only add
 * nondeterminism: a run held by the memory gate stays `queued` forever and the
 * scenario fails for a reason that has nothing to do with what it measures.
 *
 * The previous value is restored on the way out, so a harness run against a
 * live database does not leave the gates disabled.
 */
export async function withSchedulingGatesDisabled<T>(
  db: Db,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = await db
    .select()
    .from(instanceSettings)
    .limit(1)
    .then((rows) => rows[0] ?? null);

  const previousGeneral = existing?.general ?? {};

  await db
    .insert(instanceSettings)
    .values({
      singletonKey: "default",
      general: {
        ...previousGeneral,
        // 0 disables the memory floor.
        minFreeMemoryMb: 0,
        providerQuotaGateEnabled: false,
      },
      experimental: existing?.experimental ?? {},
      previews: existing?.previews ?? {},
    })
    .onConflictDoUpdate({
      target: instanceSettings.singletonKey,
      set: {
        general: {
          ...previousGeneral,
          minFreeMemoryMb: 0,
          providerQuotaGateEnabled: false,
        },
        updatedAt: new Date(),
      },
    });

  try {
    return await fn();
  } finally {
    await db
      .update(instanceSettings)
      .set({ general: previousGeneral, updatedAt: new Date() })
      .where(eq(instanceSettings.singletonKey, "default"));
  }
}

/**
 * The runs the harness produced for a company, newest first.
 */
export async function listHarnessRuns(db: Db, companyId: string) {
  return db
    .select({
      id: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      startedAt: heartbeatRuns.startedAt,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.companyId, companyId));
}

/**
 * The cost events the harness produced for a company.
 */
export async function listHarnessCosts(db: Db, companyId: string) {
  return db
    .select({
      agentId: costEvents.agentId,
      costCents: costEvents.costCents,
      inputTokens: costEvents.inputTokens,
      outputTokens: costEvents.outputTokens,
      heartbeatRunId: costEvents.heartbeatRunId,
    })
    .from(costEvents)
    .where(eq(costEvents.companyId, companyId));
}

/**
 * The issues the harness created for a company.
 */
export async function listHarnessIssues(db: Db, companyId: string) {
  return db
    .select({ id: issues.id, status: issues.status })
    .from(issues)
    .where(and(eq(issues.companyId, companyId)));
}
