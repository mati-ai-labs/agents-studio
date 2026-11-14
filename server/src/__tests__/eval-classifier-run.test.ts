import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { companies, createDb, guardrailPolicies } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { evalRoutes } from "../routes/evals.js";
import { errorHandler } from "../middleware/index.js";
import { setGuardrailClassifierForTests } from "../services/guardrail-action-review.js";
import { CLASSIFIER_BENCHMARK } from "../evals/classifier-cases.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("POST /evals/classifier-run", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-eval-classifier-run-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    setGuardrailClassifierForTests(null);
    await db.execute(sql.raw(`TRUNCATE TABLE "eval_results", "guardrail_policies", "activity_log", "companies" RESTART IDENTITY CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor: Record<string, unknown>) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    server.use("/api", evalRoutes(db));
    server.use(errorHandler);
    return server;
  }

  const board = { type: "board", userId: "u1", source: "local_implicit", isInstanceAdmin: true };

  async function seed() {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Eval Co",
      issuePrefix: `V${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  }

  // A stand-in that answers every benchmark case correctly except one it lets through.
  function stubClassifier(missId: string) {
    const byAction = new Map(CLASSIFIER_BENCHMARK.cases.map((testCase) => [JSON.stringify(testCase.input), testCase]));
    setGuardrailClassifierForTests(async (call) => {
      const testCase = byAction.get(JSON.stringify(call.toolInput))!;
      if (testCase.id === missId || testCase.expect === "allow") return { decision: "allow", ruleId: null, reason: "" };
      const rule = call.rules.find((entry) => (testCase.expect === "approval" ? entry.action === "require_approval" : entry.action === "block"));
      return { decision: testCase.expect === "approval" ? "approval" : "deny", ruleId: rule?.id ?? null, reason: `breaks ${rule?.name}` };
    });
  }

  it("scores the benchmark, stores it, and previews the company's own rules", async () => {
    await seed();
    await db.insert(guardrailPolicies).values({
      companyId, scopeType: "company", scopeId: null, stage: "action", name: "Humans ship", kind: "rule",
      matcher: { kind: "rule", rule: "Never merge pull requests or deploy." }, action: "block", severity: "high", enabled: true, version: 1,
    });
    stubClassifier("ship.gh_merge");

    const res = await request(app(board)).post(`/api/companies/${companyId}/evals/classifier-run`).send({}).expect(200);
    expect(res.body.summary).toMatchObject({ total: CLASSIFIER_BENCHMARK.cases.length, missed: 1, falseStops: 0, errors: 0 });
    expect(res.body.passed).toBe(false);
    const miss = res.body.results.find((entry: { id: string }) => entry.id === "ship.gh_merge");
    expect(miss).toMatchObject({ expect: "deny", decision: "allow", ok: false });
    expect(res.body.companyRules).toEqual([{ name: "Humans ship", rule: "Never merge pull requests or deploy.", action: "block" }]);
    expect(res.body.preview).toHaveLength(CLASSIFIER_BENCHMARK.cases.length);

    const stored = await request(app(board)).get(`/api/companies/${companyId}/evals/results?scenarioId=guardrail_classifier.benchmark`).expect(200);
    expect(stored.body).toHaveLength(1);
    expect(stored.body[0]).toMatchObject({ status: "failed", scenarioId: "guardrail_classifier.benchmark" });
    expect(stored.body[0].checks.find((check: { name: string }) => check.name === "ship.gh_merge")).toMatchObject({
      kind: "classifier_case",
      passed: false,
      observed: { expect: "deny", decision: "allow" },
    });
  });

  it("has no rule preview when the company has no rules", async () => {
    await seed();
    stubClassifier("none");
    const res = await request(app(board)).post(`/api/companies/${companyId}/evals/classifier-run`).send({}).expect(200);
    expect(res.body.passed).toBe(true);
    expect(res.body.preview).toEqual([]);
  });

  it("refuses agents", async () => {
    await seed();
    stubClassifier("none");
    await request(app({ type: "agent", agentId: randomUUID(), companyId, source: "agent_key" }))
      .post(`/api/companies/${companyId}/evals/classifier-run`)
      .send({})
      .expect(403);
  });

  it("reports an unavailable classifier instead of storing a run of errors", async () => {
    await seed();
    setGuardrailClassifierForTests(async () => {
      throw new Error("no provider key for the guardrail classifier");
    });
    const res = await request(app(board)).post(`/api/companies/${companyId}/evals/classifier-run`).send({}).expect(502);
    expect(res.body.code).toBe("classifier_unavailable");
    const stored = await request(app(board)).get(`/api/companies/${companyId}/evals/results`).expect(200);
    expect(stored.body).toHaveLength(0);
  });
});

