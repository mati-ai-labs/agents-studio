import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEvalService = vi.hoisted(() => ({
  recordResult: vi.fn(),
  listResults: vi.fn(),
  policyMetrics: vi.fn(),
  cohortComparison: vi.fn(),
  coverageReport: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

vi.mock("../services/evals.js", () => ({
  evalService: () => mockEvalService,
}));

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

async function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "user-1",
    companyIds: ["company-1"],
    source: "session",
    isInstanceAdmin: false,
  },
) {
  vi.resetModules();
  const [{ errorHandler }, { evalRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/evals.js") as Promise<typeof import("../routes/evals.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", evalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe.sequential("eval routes", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockEvalService)) mock.mockReset();
    mockAccessService.canUser.mockReset();
    mockAccessService.hasPermission.mockReset();
    mockEvalService.listResults.mockResolvedValue([]);
    mockEvalService.policyMetrics.mockResolvedValue([]);
    mockEvalService.cohortComparison.mockResolvedValue({
      cohortDefinition: "new vs established",
      ageThresholdDays: 30,
      evaluatedAt: "2026-03-01T00:00:00.000Z",
      cohorts: [],
      delta: { successRate: null, costCentsPerRun: null, avgTokensPerRun: null },
    });
    mockEvalService.coverageReport.mockResolvedValue({
      evaluatedAt: "2026-03-01T00:00:00.000Z",
      realTotal: 0,
      syntheticTotal: 0,
      coverageGaps: [],
      classes: [],
    });
  });

  it("lists results for a company the caller can access", async () => {
    mockEvalService.listResults.mockResolvedValue([
      { id: "row-1", scenarioId: "guardrails.pii_redacted", score: 1 },
    ]);

    const app = await createApp();
    const res = await request(app).get("/api/companies/company-1/evals/results");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(mockEvalService.listResults).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ scenarioId: undefined, bundleId: undefined }),
    );
  }, 30_000);

  it("forwards the scenario and bundle filters", async () => {
    const app = await createApp();
    await request(app).get("/api/companies/company-1/evals/results?scenarioId=core.pickup&bundleId=baseline");

    expect(mockEvalService.listResults).toHaveBeenCalledWith("company-1", {
      scenarioId: "core.pickup",
      bundleId: "baseline",
    });
  }, 30_000);

  it("refuses to list results for a company the caller cannot access", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-other"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).get("/api/companies/company-1/evals/results");

    expect(res.status).toBe(403);
    expect(mockEvalService.listResults).not.toHaveBeenCalled();
  }, 30_000);

  it("records a result for a caller with eval administration authority", async () => {
    mockAccessService.canUser.mockResolvedValue(true);
    mockEvalService.recordResult.mockResolvedValue({ id: "row-1", score: 0.5 });

    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/evals/results")
      .send({
        scenarioId: "guardrails.pii_redacted",
        bundleId: "baseline",
        bundle: { id: "baseline", adapter: "eval_scripted", model: "eval-scripted" },
        status: "failed",
        score: 0.5,
        checks: [{ kind: "pii_not_leaked", name: "no_email", passed: false, detail: "leaked" }],
      });

    expect(res.status).toBe(201);
    expect(mockEvalService.recordResult).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        scenarioId: "guardrails.pii_redacted",
        bundleId: "baseline",
        status: "failed",
        score: 0.5,
      }),
    );
  }, 30_000);

  it("refuses to record a result for a caller without eval administration authority", async () => {
    mockAccessService.canUser.mockResolvedValue(false);

    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/evals/results")
      .send({ scenarioId: "x", bundleId: "baseline", bundle: {}, status: "passed", score: 1 });

    expect(res.status).toBe(403);
    expect(mockEvalService.recordResult).not.toHaveBeenCalled();
  }, 30_000);

  it("returns per-policy precision and recall", async () => {
    mockEvalService.policyMetrics.mockResolvedValue([
      {
        policyId: "policy-a",
        truePositives: 2,
        falsePositives: 0,
        falseNegatives: 1,
        trueNegatives: 3,
        precision: 1,
        recall: 0.667,
        labelledScenarios: 6,
      },
    ]);

    const app = await createApp();
    const res = await request(app).get("/api/companies/company-1/evals/policy-metrics");

    expect(res.status).toBe(200);
    expect(res.body[0].policyId).toBe("policy-a");
    expect(res.body[0].recall).toBeCloseTo(0.667, 3);
  }, 30_000);

  it("returns the cohort comparison with its definition", async () => {
    const app = await createApp();
    const res = await request(app).get("/api/companies/company-1/evals/cohorts?thresholdDays=14");

    expect(res.status).toBe(200);
    expect(res.body.cohortDefinition).toBe("new vs established");
    expect(mockEvalService.cohortComparison).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ thresholdDays: 14 }),
    );
  }, 30_000);

  it("falls back to the default threshold when the query parameter is not a number", async () => {
    const app = await createApp();
    await request(app).get("/api/companies/company-1/evals/cohorts?thresholdDays=abc");

    const call = mockEvalService.cohortComparison.mock.calls[0];
    expect(call?.[1]?.thresholdDays).toBeUndefined();
  }, 30_000);

  it("compares synthetic observations against real traffic for the coverage report", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/evals/coverage")
      .send({
        synthetic: [{ class: "privacy_filter.output", label: "Privacy filter", count: 4 }],
      });

    expect(res.status).toBe(200);
    expect(mockEvalService.coverageReport).toHaveBeenCalledWith("company-1", [
      { class: "privacy_filter.output", label: "Privacy filter", count: 4 },
    ]);
  }, 30_000);

  it("derives the synthetic classes from the scenario suite when the caller supplies none", async () => {
    const app = await createApp();
    await request(app).post("/api/companies/company-1/evals/coverage").send({});

    const synthetic = mockEvalService.coverageReport.mock.calls[0]?.[1] as Array<{
      class: string;
    }>;
    // The suite declares the two failure classes it exercises, so the derived
    // side of the comparison is never empty by accident.
    expect(synthetic.map((entry) => entry.class)).toEqual(
      expect.arrayContaining([
        "privacy_filter.pii_in_task",
        "restricted_action.blocked_write",
      ]),
    );
  }, 30_000);
});
