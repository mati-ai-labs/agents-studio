import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  costEvents,
  createDb,
  evalResults,
  heartbeatRuns,
  issueComments,
  issues,
  toolCallEvents,
} from "@paperclipai/db";
import { evalService, isSuccessfulRun } from "../services/evals.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const BUNDLE = {
  id: "baseline",
  adapter: "eval_scripted",
  model: "eval-scripted",
  promptTemplate: "eval/default",
  skills: [],
} as const;

describeEmbeddedPostgres("eval layer service", () => {
  let db!: ReturnType<typeof createDb>;
  let evals!: ReturnType<typeof evalService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-eval-service-");
    db = createDb(tempDb.connectionString);
    evals = evalService(db);
  }, 30_000);

  afterEach(async () => {
    await db.delete(evalResults);
    await db.delete(toolCallEvents);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(costEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name = "Eval Co") {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `E${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("records a result with the bundle that produced it", async () => {
    await seedCompany();

    const row = await evals.recordResult({
      companyId,
      scenarioId: "guardrails.pii_redacted",
      bundleId: BUNDLE.id,
      bundle: BUNDLE,
      status: "passed",
      score: 1,
      checks: [{ kind: "pii_not_leaked", name: "no_email", passed: true, detail: "clean" }],
      costCents: 12,
      inputTokens: 120,
      outputTokens: 40,
    });

    expect(row.scenarioId).toBe("guardrails.pii_redacted");
    expect(row.bundleId).toBe("baseline");
    // The bundle travels with the score, so a score is never read without the
    // configuration that earned it.
    expect(row.bundle).toMatchObject({ adapter: "eval_scripted", model: "eval-scripted" });
    expect(row.score).toBe(1);
  });

  it("lists results newest first and filters by scenario and bundle", async () => {
    await seedCompany();

    await evals.recordResult({
      companyId,
      scenarioId: "core.assignment_pickup",
      bundleId: "baseline",
      bundle: BUNDLE,
      status: "passed",
      score: 1,
      checks: [],
      evaluatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await evals.recordResult({
      companyId,
      scenarioId: "guardrails.pii_redacted",
      bundleId: "candidate",
      bundle: { ...BUNDLE, id: "candidate" },
      status: "failed",
      score: 0.5,
      checks: [],
      evaluatedAt: new Date("2026-01-02T00:00:00.000Z"),
    });

    const all = await evals.listResults(companyId);
    expect(all.map((row) => row.scenarioId)).toEqual([
      "guardrails.pii_redacted",
      "core.assignment_pickup",
    ]);

    const filtered = await evals.listResults(companyId, { bundleId: "baseline" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.scenarioId).toBe("core.assignment_pickup");
  });

  it("does not return another company's results", async () => {
    await seedCompany("Company A");
    await evals.recordResult({
      companyId,
      scenarioId: "core.assignment_pickup",
      bundleId: "baseline",
      bundle: BUNDLE,
      status: "passed",
      score: 1,
      checks: [],
    });

    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Company B",
      issuePrefix: `E${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    expect(await evals.listResults(otherCompanyId)).toHaveLength(0);
  });

  it("computes per-policy precision and recall from the labelled results", async () => {
    await seedCompany();

    // The policy fired when it was expected to (true positive), and did not
    // fire when it was not expected to (true negative).
    await evals.recordResult({
      companyId,
      scenarioId: "scenario-1",
      bundleId: "baseline",
      bundle: BUNDLE,
      status: "passed",
      score: 1,
      checks: [],
      policyLabels: [{ policyId: "policy-a", expectation: "fire" }],
      observedPolicyFires: ["policy-a"],
    });
    await evals.recordResult({
      companyId,
      scenarioId: "scenario-2",
      bundleId: "baseline",
      bundle: BUNDLE,
      status: "passed",
      score: 1,
      checks: [],
      policyLabels: [{ policyId: "policy-a", expectation: "not_fire" }],
      observedPolicyFires: [],
    });

    const metrics = await evals.policyMetrics(companyId);
    const policyA = metrics.find((entry) => entry.policyId === "policy-a");

    expect(policyA).toBeDefined();
    expect(policyA!.truePositives).toBe(1);
    expect(policyA!.trueNegatives).toBe(1);
    expect(policyA!.falsePositives).toBe(0);
    expect(policyA!.falseNegatives).toBe(0);
    expect(policyA!.precision).toBe(1);
    expect(policyA!.recall).toBe(1);
  });

  it("produces no metric row for a policy that was never labelled", async () => {
    await seedCompany();

    await evals.recordResult({
      companyId,
      scenarioId: "scenario-1",
      bundleId: "baseline",
      bundle: BUNDLE,
      status: "passed",
      score: 1,
      checks: [],
      policyLabels: [{ policyId: "policy-a", expectation: "fire" }],
      observedPolicyFires: ["policy-b"],
    });

    const metrics = await evals.policyMetrics(companyId);
    expect(metrics.map((entry) => entry.policyId)).toEqual(["policy-a"]);
    // The unlabelled policy never fired in a labelled scenario, so it is
    // unmeasured rather than a total failure.
    expect(metrics.find((entry) => entry.policyId === "policy-b")).toBeUndefined();
  });

  it("buckets agents by age and reports a null delta when a cohort is empty", async () => {
    await seedCompany();
    const evaluatedAt = new Date("2026-03-01T00:00:00.000Z");

    const newAgentId = randomUUID();
    const establishedAgentId = randomUUID();
    await db.insert(agents).values([
      {
        id: newAgentId,
        companyId,
        name: "New Agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        createdAt: new Date("2026-02-25T00:00:00.000Z"),
      },
      {
        id: establishedAgentId,
        companyId,
        name: "Established Agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
      },
    ]);

    await db.insert(heartbeatRuns).values([
      {
        id: randomUUID(),
        companyId,
        agentId: newAgentId,
        status: "succeeded",
        startedAt: new Date("2026-02-26T00:00:00.000Z"),
      },
      {
        id: randomUUID(),
        companyId,
        agentId: establishedAgentId,
        status: "succeeded",
        startedAt: new Date("2026-02-26T00:00:00.000Z"),
      },
      {
        id: randomUUID(),
        companyId,
        agentId: establishedAgentId,
        status: "failed",
        startedAt: new Date("2026-02-26T00:00:00.000Z"),
      },
    ]);

    await db.insert(costEvents).values({
      companyId,
      agentId: newAgentId,
      provider: "openai",
      biller: "openai",
      billingType: "subscription_included",
      costStatus: "priced",
      model: "gpt-5.6-terra",
      inputTokens: 100,
      outputTokens: 50,
      costCents: 10,
      occurredAt: new Date("2026-02-26T00:00:00.000Z"),
    });

    const comparison = await evals.cohortComparison(companyId, { evaluatedAt });

    const newCohort = comparison.cohorts.find((c) => c.cohort === "new");
    const establishedCohort = comparison.cohorts.find((c) => c.cohort === "established");

    expect(newCohort!.agents).toBe(1);
    expect(newCohort!.runs).toBe(1);
    expect(newCohort!.successRate).toBe(1);
    expect(newCohort!.costCentsPerRun).toBe(10);

    expect(establishedCohort!.agents).toBe(1);
    expect(establishedCohort!.runs).toBe(2);
    expect(establishedCohort!.successfulRuns).toBe(1);
    expect(establishedCohort!.failedRuns).toBe(1);
    expect(establishedCohort!.successRate).toBe(0.5);

    expect(comparison.ageThresholdDays).toBe(30);
    expect(comparison.delta.successRate).toBe(0.5);
  });

  it("reports no per-run figures for a cohort with no runs", async () => {
    await seedCompany();
    const evaluatedAt = new Date("2026-03-01T00:00:00.000Z");

    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Brand New Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      createdAt: new Date("2026-02-28T00:00:00.000Z"),
    });

    const comparison = await evals.cohortComparison(companyId, { evaluatedAt });
    const newCohort = comparison.cohorts.find((c) => c.cohort === "new");

    expect(newCohort!.agents).toBe(1);
    expect(newCohort!.runs).toBe(0);
    // An empty cohort has no success rate, so it is not reported as 0%.
    expect(newCohort!.successRate).toBeNull();
    expect(newCohort!.costCentsPerRun).toBeNull();
    // The delta against an empty established cohort is undefined, not zero.
    expect(comparison.delta.successRate).toBeNull();
  });

  it("reports a real failure class the synthetic suite never produces as a coverage gap", async () => {
    await seedCompany();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Eval Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Eval issue",
      description: "Eval issue",
      status: "todo",
      priority: "medium",
    });

    // A blocked tool call in real traffic: the restricted-action failure.
    await db.insert(toolCallEvents).values({
      companyId,
      eventType: "tool_call",
      agentId,
      issueId,
      toolName: "mcp-remote-fixture:update_note",
      decision: "deny",
      matchedPolicyIds: [],
      outcome: "denied",
    });

    const report = await evals.coverageReport(companyId, [
      { class: "privacy_filter.pii_in_task", label: "Privacy filter", count: 4 },
    ]);

    const gap = report.coverageGaps.find(
      (entry) => entry.class === "restricted_action.blocked_write",
    );
    expect(gap).toBeDefined();
    expect(gap!.realCount).toBe(1);
    expect(gap!.syntheticCount).toBe(0);

    // The synthetic-only class is not a gap; it is a class the suite produces
    // that real traffic has not hit yet.
    expect(report.coverageGaps.map((entry) => entry.class)).not.toContain(
      "privacy_filter.pii_in_task",
    );
    expect(report.realTotal).toBe(1);
    expect(report.syntheticTotal).toBe(4);
  });

  it("counts a sensitive value echoed into a comment as a privacy-filter violation", async () => {
    await seedCompany();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Eval Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Eval issue",
      description: "Eval issue",
      status: "todo",
      priority: "medium",
    });
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorType: "agent",
      authorAgentId: agentId,
      body: "The customer record for SSN 123-45-6789 was rotated.",
    });

    const report = await evals.coverageReport(companyId, []);

    const leak = report.classes.find((entry) => entry.class === "privacy_filter.pii_in_task");
    expect(leak).toBeDefined();
    expect(leak!.realCount).toBe(1);
  });

  it("does not count a tool call the policy engine allowed as a violation", async () => {
    await seedCompany();
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Eval Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(toolCallEvents).values({
      companyId,
      eventType: "tool_call",
      agentId,
      toolName: "mcp-remote-fixture:read_note",
      decision: "allow",
      matchedPolicyIds: [],
      outcome: "allowed",
    });

    const report = await evals.coverageReport(companyId, []);

    expect(report.realTotal).toBe(0);
    expect(report.coverageGaps).toEqual([]);
  });
});

describe("eval run classification", () => {
  it("counts only terminal-attempt statuses as successful runs", () => {
    expect(isSuccessfulRun("succeeded")).toBe(true);
    expect(isSuccessfulRun("completed")).toBe(true);
    expect(isSuccessfulRun("failed")).toBe(false);
    expect(isSuccessfulRun("cancelled")).toBe(false);
    expect(isSuccessfulRun("queued")).toBe(false);
  });
});
