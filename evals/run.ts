/**
 * The eval harness command line.
 *
 * Everything the harness needs is in this repo, so a deterministic eval run
 * needs no model provider credentials: the scenarios are driven by a scripted
 * adapter that exercises the real control plane (tool access policy, comment
 * creation, issue lifecycle, run accounting).
 *
 * Usage:
 *   pnpm evals:run                     run every scenario, write the report
 *   pnpm evals:run -- --scenario <id>  run one scenario
 *   pnpm evals:run -- --json <path>    also write the report as JSON
 *   pnpm evals:run -- --live [--model <id>] [--scenario <id>]
 *                                      run the `live` scenarios with a REAL
 *                                      claude_local agent on a real studio
 *                                      server (uses the provider in your env;
 *                                      costs tokens)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareBundles,
  judgeBundleComparison,
  resolveBundle,
  syntheticViolationClasses,
  type EvalBundle,
  type EvalBundleComparison,
  type EvalCohortComparison,
  type EvalCoverageReport,
  type EvalPolicyMetrics,
  type EvalScenarioFile,
  type EvalScenarioResult,
} from "../packages/shared/src/index.js";
import {
  createDb,
  startEmbeddedPostgresTestDatabase,
} from "../packages/db/src/index.js";
import { loadScenarios } from "../server/src/evals/scenario-file.js";
import {
  createEvalCompany,
  recordScenarioResult,
  runScenario,
  runScenarioLive,
  withSchedulingGatesDisabled,
} from "../server/src/evals/runner.js";
import { evalService } from "../server/src/services/evals.js";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const scenariosDir = path.join(repoRoot, "evals", "scenarios");

/**
 * The bundles the harness compares.
 *
 * A bundle is the whole configuration that determines behaviour — adapter,
 * model, prompt template, skills and runtime flags — so the comparison is
 * between configurations, not between models.
 */
const BUNDLES: EvalBundle[] = [
  {
    id: "baseline.eval-scripted",
    adapter: "eval_scripted",
    model: "eval-scripted",
    promptTemplate: "baseline",
    skills: [],
    flags: {},
  },
  {
    id: "candidate.eval-scripted",
    adapter: "eval_scripted",
    model: "eval-scripted",
    promptTemplate: "candidate",
    skills: ["synthetic-guardrails"],
    flags: { strictPrivacyFilter: true },
  },
];

interface CliOptions {
  scenarioId?: string;
  bundleIds: string[];
  jsonPath?: string;
  /** Run the `live` scenarios with a real claude_local agent instead of the scripted ones. */
  live: boolean;
  /** Model for the live agent (default: the CLI's configured model). */
  model?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { bundleIds: BUNDLES.map((bundle) => bundle.id), live: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--scenario") {
      options.scenarioId = argv[index + 1];
      index += 1;
    } else if (arg === "--bundle") {
      options.bundleIds = argv[index + 1].split(",").map((value) => value.trim()).filter(Boolean);
      index += 1;
    } else if (arg === "--json") {
      options.jsonPath = argv[index + 1];
      index += 1;
    } else if (arg === "--live") {
      options.live = true;
    } else if (arg === "--model") {
      options.model = argv[index + 1];
      index += 1;
    }
  }

  return options;
}

interface ScenarioReport {
  scenarioId: string;
  description: string;
  violationClass: string | null;
  bundleId: string;
  status: string;
  score: number;
  checks: Array<{ kind: string; name: string; passed: boolean; detail: string }>;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
  error: string | null;
  recordedRowId: string;
}

interface HarnessReport {
  generatedAt: string;
  scenarios: ScenarioReport[];
  bundleComparisons: EvalBundleComparison[];
  bundleVerdicts: Array<{
    scenarioId: string;
    baselineBundleId: string;
    candidateBundleId: string;
    acceptable: boolean;
    qualityNonInferior: boolean;
    efficiencyNonInferior: boolean;
    qualityDelta: number;
    efficiencyDelta: number;
    reasons: string[];
  }>;
  policyMetrics: EvalPolicyMetrics[];
  cohort: EvalCohortComparison;
  coverage: EvalCoverageReport;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const allScenarios = loadScenarios(scenariosDir).filter((scenario) =>
    options.live ? scenario.mode === "live" : scenario.mode !== "live",
  );
  if (options.live) {
    await runLive(options, allScenarios);
    return;
  }
  const scenarios = options.scenarioId
    ? allScenarios.filter((scenario) => scenario.id === options.scenarioId)
    : allScenarios;

  if (scenarios.length === 0) {
    throw new Error(
      options.scenarioId
        ? `no scenario with id "${options.scenarioId}" (available: ${allScenarios.map((s) => s.id).join(", ")})`
        : `no scenarios found in ${scenariosDir}`,
    );
  }

  const bundles = BUNDLES.filter((bundle) => options.bundleIds.includes(bundle.id));
  if (bundles.length === 0) {
    throw new Error(`no bundle matched ${options.bundleIds.join(", ")}`);
  }

  console.log(
    `Running ${scenarios.length} scenario(s) x ${bundles.length} bundle(s) against an embedded database...`,
  );

  const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-evals-");
  const db = createDb(tempDb.connectionString);
  const evals = evalService(db);

  const scenarioReports: ScenarioReport[] = [];
  const resultsByScenario = new Map<string, EvalScenarioResult[]>();

  // Every scenario shares one company, so the eval results, the cohort metric
  // and the coverage report all aggregate over the same population.
  const companyId = await createEvalCompany(db, { name: "Eval Harness" });

  try {
    await withSchedulingGatesDisabled(db, async () => {
      for (const scenario of scenarios) {
        for (const bundle of bundles) {
          const run = await runScenario({
            db,
            scenario,
            bundle: resolveBundle(scenario.bundle, bundle),
            companyId,
          });

          const recorded = await recordScenarioResult(db, {
            companyId: run.seeded.companyId,
            scenario,
            bundle: resolveBundle(scenario.bundle, bundle),
            result: run.result,
            runId: run.seeded.runId,
          });

          const byScenario = resultsByScenario.get(scenario.id) ?? [];
          byScenario.push(run.result);
          resultsByScenario.set(scenario.id, byScenario);

          scenarioReports.push({
            scenarioId: scenario.id,
            description: scenario.description,
            violationClass: scenario.violationClass?.class ?? null,
            bundleId: bundle.id,
            status: run.result.status,
            score: run.result.score,
            checks: run.result.checks.map((check) => ({
              kind: check.kind,
              name: check.name,
              passed: check.passed,
              detail: check.detail,
            })),
            costCents: run.result.efficiency.costCents,
            inputTokens: run.result.efficiency.inputTokens,
            outputTokens: run.result.efficiency.outputTokens,
            error: run.result.error,
            recordedRowId: recorded.id,
          });

          const failedChecks = run.result.checks.filter((check) => !check.passed);
          const status = run.result.status === "passed" ? "PASS" : "FAIL";
          console.log(
            `  ${status} ${scenario.id} [${bundle.id}] score=${run.result.score.toFixed(2)}` +
              (failedChecks.length > 0
                ? ` (${failedChecks.map((check) => check.name).join(", ")})`
                : ""),
          );
          if (run.result.error) console.log(`       error: ${run.result.error}`);
        }
      }
    });

    // Read the scores back out of `eval_results` to prove the round trip.
    const readBack = await evals.listResults(companyId, {});
    console.log(
      `Read back ${readBack.length} result row(s) for company ${companyId.slice(0, 8)}...`,
    );

    const bundleComparisons = [...resultsByScenario.entries()].map(([scenarioId, results]) =>
      compareBundles(scenarioId, results),
    );

    const bundleVerdicts = bundleComparisons.flatMap((comparison) => {
      const baseline = comparison.bundles.find((entry) => entry.bundleId === bundles[0]?.id);
      const candidate = comparison.bundles.find((entry) => entry.bundleId === bundles[1]?.id);
      if (!baseline || !candidate) return [];
      const verdict = judgeBundleComparison(
        {
          score: baseline.score,
          costCents: baseline.costCents,
          totalTokens: baseline.inputTokens + baseline.outputTokens,
        },
        {
          score: candidate.score,
          costCents: candidate.costCents,
          totalTokens: candidate.inputTokens + candidate.outputTokens,
        },
      );
      return [
        {
          scenarioId: comparison.scenarioId,
          baselineBundleId: baseline.bundleId,
          candidateBundleId: candidate.bundleId,
          ...verdict,
        },
      ];
    });

    // Policy precision/recall is computed over the labelled results of the
    // company the scenarios ran in.
    const policyMetrics = await evals.policyMetrics(companyId, {});

    // The cohort metric reads the run and cost history the harness itself
    // produced, so it returns real numbers rather than zeros.
    const cohort = await evals.cohortComparison(companyId, {});

    // The coverage report compares the synthetic baseline against the real
    // traffic the harness generated.
    const coverage = await evals.coverageReport(
      companyId,
      syntheticViolationClasses(scenarios),
    );

    const report: HarnessReport = {
      generatedAt: new Date().toISOString(),
      scenarios: scenarioReports,
      bundleComparisons,
      bundleVerdicts,
      policyMetrics,
      cohort,
      coverage,
    };

    const json = JSON.stringify(report, null, 2);
    if (options.jsonPath) {
      await writeFile(path.resolve(repoRoot, options.jsonPath), `${json}\n`, "utf8");
      console.log(`Wrote ${options.jsonPath}`);
    }

    console.log("");
    console.log("Bundle comparison");
    for (const verdict of bundleVerdicts) {
      console.log(
        `  ${verdict.scenarioId}: ${verdict.acceptable ? "acceptable" : "NOT acceptable"}` +
          ` (quality delta ${verdict.qualityDelta.toFixed(3)}, cost delta ${verdict.efficiencyDelta.toFixed(2)}c)`,
      );
    }

    console.log("");
    console.log("Policy metrics");
    for (const metric of policyMetrics) {
      console.log(
        `  ${metric.policyId}: precision=${formatRate(metric.precision)} recall=${formatRate(metric.recall)}` +
          ` (tp=${metric.truePositives} fp=${metric.falsePositives} fn=${metric.falseNegatives} tn=${metric.trueNegatives})`,
      );
    }
    if (policyMetrics.length === 0) {
      console.log("  (no policy labels resolved)");
    }

    console.log("");
    console.log(`Cohort metric — ${cohort.cohortDefinition}`);
    for (const bucket of cohort.cohorts) {
      console.log(
        `  ${bucket.cohort}: agents=${bucket.agents} runs=${bucket.runs} successRate=${formatRate(bucket.successRate)}` +
          ` costCentsPerRun=${bucket.costCentsPerRun === null ? "n/a" : bucket.costCentsPerRun.toFixed(2)}`,
      );
    }

    console.log("");
    console.log("Synthetic vs real coverage");
    console.log(`  real total=${coverage.realTotal} synthetic total=${coverage.syntheticTotal}`);
    for (const entry of coverage.classes) {
      console.log(
        `  ${entry.class}: real=${entry.realCount} synthetic=${entry.syntheticCount}` +
          (entry.coverageGap ? "  <-- COVERAGE GAP" : ""),
      );
    }
    if (coverage.coverageGaps.length === 0) {
      console.log("  no coverage gaps");
    }

    const failures = scenarioReports.filter((report) => report.status !== "passed");
    if (failures.length > 0) {
      console.log("");
      console.log(`${failures.length} scenario(s) did not pass.`);
      process.exitCode = 1;
    }
  } finally {
    await tempDb.cleanup();
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Start a real studio server process on the harness database, so a live agent
 * gets exactly what it gets on prod: the API, its skills, and the guardrail
 * hook. Provider env (ANTHROPIC_*, GUARDRAIL_CLASSIFIER_*) is passed through.
 */
async function startStudioServer(databaseUrl: string): Promise<{ apiBase: string; stop: () => void; logPath: string }> {
  const port = await freePort();
  const home = await mkdtemp(path.join(os.tmpdir(), "paperclip-eval-home-"));
  const logPath = path.join(home, "server.log");
  const { createWriteStream } = await import("node:fs");
  const log = createWriteStream(logPath);
  const child: ChildProcess = spawn(
    path.join(repoRoot, "node_modules", ".bin", "tsx"),
    ["src/index.ts"],
    {
      cwd: path.join(repoRoot, "server"),
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        PORT: String(port),
        PAPERCLIP_HOME: home,
        PAPERCLIP_INSTANCE_ID: "evals",
        PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
        PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
        PAPERCLIP_MIGRATION_PROMPT: "never",
        PAPERCLIP_AGENT_JWT_SECRET: process.env.PAPERCLIP_AGENT_JWT_SECRET ?? randomBytes(24).toString("hex"),
        PAPERCLIP_API_URL: `http://127.0.0.1:${port}`,
        SERVE_UI: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  const apiBase = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const res = await fetch(`${apiBase}/api/health`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (child.exitCode !== null) throw new Error(`studio server exited (${child.exitCode}); see ${logPath}`);
    if (Date.now() > deadline) throw new Error(`studio server did not start; see ${logPath}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { apiBase, stop: () => child.kill("SIGTERM"), logPath };
}

/** Live mode: real agents, real server, same checks. */
async function runLive(options: CliOptions, allScenarios: EvalScenarioFile[]) {
  const scenarios = options.scenarioId
    ? allScenarios.filter((scenario) => scenario.id === options.scenarioId)
    : allScenarios;
  if (scenarios.length === 0) throw new Error("no live scenarios found");

  const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-evals-live-");
  const db = createDb(tempDb.connectionString);
  const server = await startStudioServer(tempDb.connectionString);
  console.log(`Live mode: ${scenarios.length} scenario(s), real claude_local agent, studio server at ${server.apiBase}`);
  console.log(`  server log: ${server.logPath}`);
  const bundle: EvalBundle = {
    id: `live.claude_local${options.model ? `.${options.model}` : ""}`,
    adapter: "claude_local",
    model: options.model ?? "default",
    promptTemplate: "prod",
    skills: [],
    flags: {},
  };
  const reports: ScenarioReport[] = [];
  try {
    const companyId = await createEvalCompany(db, { name: "Eval Harness (live)" });
    for (const scenario of scenarios) {
      const run = await runScenarioLive({
        db,
        scenario,
        apiBase: server.apiBase,
        companyId,
        bundle,
        adapterConfig: options.model ? { model: options.model } : {},
      });
      const recorded = await recordScenarioResult(db, { companyId, scenario, bundle, result: run.result, runId: run.seeded.runId });
      reports.push({
        scenarioId: scenario.id,
        description: scenario.description,
        violationClass: scenario.violationClass?.class ?? null,
        bundleId: bundle.id,
        status: run.result.status,
        score: run.result.score,
        checks: run.result.checks.map((check) => ({ kind: check.kind, name: check.name, passed: check.passed, detail: check.detail })),
        costCents: run.result.efficiency.costCents,
        inputTokens: run.result.efficiency.inputTokens,
        outputTokens: run.result.efficiency.outputTokens,
        error: run.result.error,
        recordedRowId: recorded.id,
      });
      const status = run.result.status === "passed" ? "PASS" : run.result.status === "error" ? "ERROR" : "FAIL";
      console.log(`  ${status} ${scenario.id} score=${run.result.score.toFixed(2)} tokens=${run.result.efficiency.inputTokens + run.result.efficiency.outputTokens}`);
      for (const check of run.result.checks) {
        console.log(`       ${check.passed ? "ok  " : "FAIL"} ${check.name} — ${check.detail}`);
      }
      if (run.result.error) console.log(`       error: ${run.result.error}`);
    }
    if (options.jsonPath) {
      await writeFile(path.resolve(repoRoot, options.jsonPath), `${JSON.stringify({ generatedAt: new Date().toISOString(), mode: "live", scenarios: reports }, null, 2)}\n`, "utf8");
      console.log(`Wrote ${options.jsonPath}`);
    }
    const passed = reports.filter((report) => report.status === "passed").length;
    console.log("");
    console.log(`Live result: ${passed}/${reports.length} scenario(s) passed.`);
    if (passed < reports.length) process.exitCode = 1;
  } finally {
    server.stop();
    await tempDb.cleanup();
  }
}

function formatRate(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(3);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
