import { Router, type Request } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "@paperclipai/db";
import { syntheticViolationClasses } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { accessService } from "../services/access.js";
import { evalService } from "../services/evals.js";
import { loadScenarios } from "../evals/scenario-file.js";
import { assertCompanyAccess } from "./authz.js";

/**
 * Where the synthetic scenario suite lives.
 *
 * The scenarios are repo fixtures, not runtime data, so the directory is
 * resolved relative to this module first (the source layout) and then relative
 * to the working directory (the built layout, where the repo root is the cwd).
 * If neither exists the coverage report falls back to no synthetic classes,
 * which reads as "the suite covers nothing" rather than crashing the route.
 */
function resolveScenariosDir(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../../../evals/scenarios"),
    path.resolve(process.cwd(), "evals/scenarios"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function evalRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  const evals = evalService(db);

  /**
   * Eval results and metrics are company-scoped and readable by anyone with
   * company access; writing a result additionally requires the permission to
   * administer company settings, because a result is an assertion about the
   * company's agents that other callers rely on.
   */
  async function assertCanRecordEvals(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      if (await access.canUser(companyId, req.actor.userId, "users:manage_permissions")) return;
    } else if (
      req.actor.type === "agent"
      && req.actor.agentId
      && (await access.hasPermission(companyId, "agent", req.actor.agentId, "users:manage_permissions"))
    ) {
      return;
    }
    throw forbidden("Eval administration authority required", {
      code: "eval_admin_required",
      remediation: "Ask a company administrator to record eval results.",
    });
  }

  router.get("/companies/:companyId/evals/results", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const results = await evals.listResults(companyId, {
      scenarioId: typeof req.query.scenarioId === "string" ? req.query.scenarioId : undefined,
      bundleId: typeof req.query.bundleId === "string" ? req.query.bundleId : undefined,
    });
    res.json(results);
  });

  router.post("/companies/:companyId/evals/results", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanRecordEvals(req, companyId);
    const body = req.body ?? {};
    const row = await evals.recordResult({
      companyId,
      scenarioId: String(body.scenarioId ?? ""),
      scenarioVersion: body.scenarioVersion ? String(body.scenarioVersion) : undefined,
      bundleId: String(body.bundleId ?? ""),
      bundle: body.bundle ?? {},
      status: body.status ?? "error",
      score: Number(body.score ?? 0),
      checks: Array.isArray(body.checks) ? body.checks : [],
      costCents: body.costCents ? Number(body.costCents) : undefined,
      inputTokens: body.inputTokens ? Number(body.inputTokens) : undefined,
      outputTokens: body.outputTokens ? Number(body.outputTokens) : undefined,
      cachedInputTokens: body.cachedInputTokens ? Number(body.cachedInputTokens) : undefined,
      heartbeatRunId: body.heartbeatRunId ? String(body.heartbeatRunId) : null,
      observedPolicyFires: Array.isArray(body.observedPolicyFires) ? body.observedPolicyFires : [],
      policyLabels: Array.isArray(body.policyLabels) ? body.policyLabels : [],
      error: body.error ? String(body.error) : null,
    });
    res.status(201).json(row);
  });

  /**
   * Per-policy precision and recall over the labelled results.
   */
  router.get("/companies/:companyId/evals/policy-metrics", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const metrics = await evals.policyMetrics(companyId, {
      scenarioId: typeof req.query.scenarioId === "string" ? req.query.scenarioId : undefined,
      bundleId: typeof req.query.bundleId === "string" ? req.query.bundleId : undefined,
    });
    res.json(metrics);
  });

  /**
   * The new-vs-established agent metric.
   *
   * The cohort definition travels with the response so a reader never has to
   * guess what "new" meant on the day the number was computed.
   */
  router.get("/companies/:companyId/evals/cohorts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const thresholdDays = req.query.thresholdDays ? Number(req.query.thresholdDays) : undefined;
    const comparison = await evals.cohortComparison(companyId, {
      thresholdDays: Number.isFinite(thresholdDays) ? thresholdDays : undefined,
    });
    res.json(comparison);
  });

  /**
   * The synthetic-vs-real coverage report.
   *
   * The synthetic side is derived from the scenario suite: every scenario
   * declares the violation class it exercises, so the suite itself is the
   * record of what it can reproduce. A caller that ran a different suite (a
   * private fork, a partial run) can still pass its own observations, and they
   * replace the derived ones.
   */
  router.post("/companies/:companyId/evals/coverage", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const body = req.body ?? {};
    const synthetic = Array.isArray(body.synthetic)
      ? body.synthetic.map((entry: Record<string, unknown>) => ({
          class: String(entry.class ?? ""),
          label: String(entry.label ?? entry.class ?? ""),
          count: Number(entry.count ?? 0),
        }))
      : deriveSyntheticClasses();
    const report = await evals.coverageReport(companyId, synthetic);
    res.json(report);
  });

  return router;
}

/**
 * The violation classes the checked-in scenario suite can produce.
 *
 * A missing or unreadable scenario directory yields no classes rather than an
 * error: the coverage report is a diagnostic, and a broken fixture path should
 * not take the route down.
 */
function deriveSyntheticClasses() {
  const dir = resolveScenariosDir();
  if (!dir) return [];
  try {
    return syntheticViolationClasses(loadScenarios(dir));
  } catch {
    return [];
  }
}
