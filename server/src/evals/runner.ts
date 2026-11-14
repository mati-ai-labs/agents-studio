import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  guardrailPolicies,
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
  seeded: {
    companyId: string;
    agentId: string;
    /** null when the scenario failed before it could be seeded. */
    issueId: string | null;
    runId: string | null;
    /** The seeded tool policy, when the scenario declares one. */
    seededPolicyId: string | null;
  };
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

  const evaluatedAt = new Date();
  let runId: string | null = null;
  let error: string | null = null;
  let seeded: {
    companyId: string;
    agentId: string;
    issueId: string | null;
    seededPolicyId: string | null;
  } | null = null;

  try {
    const seededScenario = await seedScenario(db, scenario, bundle, options.companyId);
    seeded = seededScenario;

    const adapter = createScriptedAdapter(db, {
      script: scenario.script,
      issueId: seededScenario.issueId,
      companyId: seededScenario.companyId,
    });
    registerServerAdapter(adapter);

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
    // A failure to seed or run is a property of this scenario/bundle pair, not
    // a reason to abandon the rest of the harness run. Recording it as an
    // errored result keeps the comparison complete and makes the failure
    // visible instead of silently dropping the scenario.
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    unregisterServerAdapter(EVAL_SCRIPTED_ADAPTER_TYPE);
  }

  const trace = await collectTrace(db, {
    companyId: seeded?.companyId ?? options.companyId ?? "",
    issueId: seeded?.issueId ?? null,
    runId,
  });

  const checks: EvalCheckDetail[] = scenario.checks.map((spec) => evaluateCheck(spec, trace));
  const score = scoreChecks(checks);
  const observedPolicyFires = collectObservedPolicyFires(trace);
  const policyLabels = await resolvePolicyLabels(
    db,
    seeded?.companyId ?? options.companyId ?? "",
    scenario.policyLabels,
  );

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
    seeded: {
      companyId: seeded?.companyId ?? options.companyId ?? "",
      agentId: seeded?.agentId ?? "",
      issueId: seeded?.issueId ?? null,
      seededPolicyId: seeded?.seededPolicyId ?? null,
      runId,
    },
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
): Promise<{ companyId: string; agentId: string; issueId: string; seededPolicyId: string | null }> {
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

  let seededPolicyId: string | null = null;
  if (scenario.seedPolicy) {
    seededPolicyId = await seedToolPolicy(db, resolvedCompanyId, scenario.seedPolicy);
  }

  return { companyId: resolvedCompanyId, agentId, issueId, seededPolicyId };
}

/**
 * Seed the scenario's tool policy, reusing the existing row when it is there.
 *
 * `tool_policies` has a unique constraint on (company_id, name), and a harness
 * run seeds the same scenario once per bundle into one shared company. Creating
 * a second row with the same name would fail on that constraint, and creating a
 * differently-named row would leave two policies matching the same tool, so
 * every blocked call would report the policy twice.
 *
 * Reusing the row keeps exactly one policy in force, which is what the
 * scenario's precision/recall labels are written against.
 */
async function seedToolPolicy(
  db: Db,
  companyId: string,
  seedPolicy: NonNullable<EvalScenarioFile["seedPolicy"]>,
): Promise<string> {
  const existing = await db
    .select({ id: toolPolicies.id })
    .from(toolPolicies)
    .where(and(eq(toolPolicies.companyId, companyId), eq(toolPolicies.name, seedPolicy.name)))
    .then((rows) => rows[0] ?? null);

  if (existing) return existing.id;

  const inserted = await db
    .insert(toolPolicies)
    .values({
      companyId,
      name: seedPolicy.name,
      policyType: seedPolicy.policyType,
      priority: seedPolicy.priority ?? 100,
      selectors: seedPolicy.selectors,
      conditions: seedPolicy.conditions ?? null,
      config: seedPolicy.config ?? null,
      enabled: true,
    })
    .returning({ id: toolPolicies.id });

  const id = inserted[0]?.id;
  if (!id) {
    throw new Error(`failed to seed tool policy "${seedPolicy.name}"`);
  }
  return id;
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


// ---------------------------------------------------------------------------
// Live mode: a real agent against a real studio server
// ---------------------------------------------------------------------------

export interface LiveScenarioRunOptions {
  db: Db;
  scenario: EvalScenarioFile;
  /** Base URL of a running studio server that shares `db` (e.g. http://127.0.0.1:3299). */
  apiBase: string;
  companyId: string;
  /** adapterConfig for the agent under test (claude_local). */
  adapterConfig?: Record<string, unknown>;
  /** How long the real agent may take. Default 10 minutes. */
  timeoutMs?: number;
  bundle?: EvalBundle;
}

function fillTemplate(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);
}

/**
 * Run one scenario with a real agent.
 *
 * The agent is a claude_local agent — the adapter prod runs — woken through
 * the studio's own API on a real server process, so it gets the same prompt,
 * skills, guardrail hook and API as on prod. The checks then score what it
 * actually did to the studio: comments, sub-issues, approvals, guardrail
 * decisions, and whether it touched another agent's config.
 */
export async function runScenarioLive(options: LiveScenarioRunOptions): Promise<ScenarioRun> {
  const { db, scenario, apiBase, companyId } = options;
  const bundle = options.bundle ?? scenario.bundle;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const evaluatedAt = new Date();
  let runId: string | null = null;
  let error: string | null = null;
  const agentId = randomUUID();
  const issueId = randomUUID();
  let bystander: { agentId: string; originalAdapterConfig: unknown } | null = null;

  try {
    if (scenario.bystanderAgent) {
      const bystanderId = randomUUID();
      const adapterConfig = scenario.bystanderAgent.adapterConfig ?? { model: "MiniMax-M3.1-Flash", effort: "low" };
      await db.insert(agents).values({
        id: bystanderId,
        companyId,
        name: scenario.bystanderAgent.name,
        role: scenario.bystanderAgent.role ?? "engineer",
        // Paused so the studio never runs it during the scenario.
        status: "paused",
        adapterType: "claude_local",
        adapterConfig,
        runtimeConfig: {},
        permissions: {},
      });
      bystander = { agentId: bystanderId, originalAdapterConfig: adapterConfig };
    }

    const values = { issueId, companyId, agentId, bystanderAgentId: bystander?.agentId ?? "" };
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: scenario.task.agentName ?? `Eval Agent ${scenario.id}`,
      role: scenario.task.agentRole ?? "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: { dangerouslySkipPermissions: true, ...(options.adapterConfig ?? {}) },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: fillTemplate(scenario.task.title, values),
      description: fillTemplate(scenario.task.description, values),
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    for (const rule of scenario.seedGuardrailRules ?? []) {
      const existing = await db
        .select({ id: guardrailPolicies.id })
        .from(guardrailPolicies)
        .where(and(eq(guardrailPolicies.companyId, companyId), eq(guardrailPolicies.name, rule.name)))
        .then((rows) => rows[0] ?? null);
      if (existing) continue;
      await db.insert(guardrailPolicies).values({
        companyId,
        scopeType: "company",
        scopeId: null,
        stage: "action",
        name: rule.name,
        kind: "rule",
        matcher: { kind: "rule", rule: rule.rule },
        action: rule.action,
        severity: "high",
        enabled: true,
        version: 1,
      });
    }

    const response = await fetch(`${apiBase.replace(/\/+$/, "")}/api/agents/${agentId}/heartbeat/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "eval_scenario", payload: { issueId } }),
    });
    if (!response.ok) throw new Error(`waking the agent failed: HTTP ${response.status} ${await response.text()}`);
    const woken = (await response.json()) as { id?: string } | null;
    runId = typeof woken?.id === "string" ? woken.id : null;

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await db
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      const run = (runId ? rows.find((row) => row.id === runId) : null) ?? rows[0] ?? null;
      if (run) runId = run.id;
      if (run && ["succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(run.status)) break;
      if (Date.now() > deadline) throw new Error(`the agent did not finish within ${Math.round(timeoutMs / 1000)}s`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  const trace = await collectTrace(db, { companyId, issueId, runId, bystander, agentId });
  const checks: EvalCheckDetail[] = scenario.checks.map((spec) => evaluateCheck(spec, trace));
  const score = scoreChecks(checks);
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
    policyLabels: [],
    observedPolicyFires: collectObservedPolicyFires(trace),
    error,
    evaluatedAt: evaluatedAt.toISOString(),
  };
  return {
    result,
    seeded: { companyId, agentId, issueId, runId, seededPolicyId: null },
    violationClass: scenario.violationClass,
  };
}
