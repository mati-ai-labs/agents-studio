import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  createDb,
  guardrailPolicies,
  guardrailViolations,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  evaluatePolicy,
  guardrailService,
  resolveEffectivePolicies,
} from "../services/guardrails.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres guardrail policy tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type PolicyInsert = typeof guardrailPolicies.$inferInsert;

describeEmbeddedPostgres("guardrail policy service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-guardrails-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(guardrailViolations);
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(guardrailPolicies);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Guardrail Co",
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Guardrail Agent",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      status: "idle",
    });
    return { companyId, agentId };
  }

  async function insertPolicy(overrides: Partial<PolicyInsert> = {}): Promise<PolicyInsert> {
    const [policy] = await db
      .insert(guardrailPolicies)
      .values({
        companyId,
        scopeType: "company",
        scopeId: null,
        stage: "input",
        name: `Policy ${randomUUID().slice(0, 8)}`,
        kind: "regex",
        matcher: { kind: "regex", patterns: ["secret"] },
        action: "redact",
        severity: "medium",
        enabled: true,
        version: 1,
        ...overrides,
      })
      .returning();
    return policy!;
  }

  // -------------------------------------------------------------------------
  // Resolution precedence
  // -------------------------------------------------------------------------

  it("resolves company and scoped policies in one query", async () => {
    await seedCompany();
    const projectId = randomUUID();
    await insertPolicy({ name: "company-policy", scopeType: "company", scopeId: null });
    await insertPolicy({
      name: "agent-policy",
      scopeType: "agent",
      scopeId: agentId,
    });
    await insertPolicy({
      name: "project-policy",
      scopeType: "project",
      scopeId: projectId,
    });
    await insertPolicy({
      name: "other-agent-policy",
      scopeType: "agent",
      scopeId: randomUUID(),
    });
    await insertPolicy({ name: "disabled-policy", enabled: false });
    await insertPolicy({ name: "output-stage-policy", stage: "output" });

    const resolved = await resolveEffectivePolicies(db, {
      companyId,
      stage: "input",
      agentId,
      projectId,
      scopeIds: [agentId, projectId],
    });

    expect(resolved.map((entry) => entry.policy.name).sort()).toEqual([
      "agent-policy",
      "company-policy",
      "project-policy",
    ]);
  });

  it("prefers the more specific scope when two policies of the same kind conflict", async () => {
    await seedCompany();
    const projectId = randomUUID();
    await insertPolicy({
      name: "company-redact",
      scopeType: "company",
      kind: "pii",
      matcher: { kind: "pii", piiTypes: ["email"] },
      action: "redact",
      severity: "critical",
    });
    await insertPolicy({
      name: "project-block",
      scopeType: "project",
      scopeId: projectId,
      kind: "pii",
      matcher: { kind: "pii", piiTypes: ["email"] },
      action: "block",
      severity: "info",
    });

    const service = guardrailService(db);
    const decision = await service.applyGuardrails(
      {
        companyId,
        agentId,
        projectId,
        text: "reach me at patient@example.com",
        fields: { comment: "reach me at patient@example.com" },
      },
      { stage: "input" },
    );

    expect(decision.action).toBe("block");
    expect(decision.decisive?.policyName).toBe("project-block");
  });

  it("prefers the highest severity within a scope", async () => {
    await seedCompany();
    await insertPolicy({
      name: "low-severity",
      scopeType: "company",
      severity: "info",
      action: "redact",
    });
    await insertPolicy({
      name: "high-severity",
      scopeType: "company",
      severity: "high",
      action: "redact",
    });

    const service = guardrailService(db);
    const decision = await service.applyGuardrails(
      { companyId, agentId, text: "secret", fields: { comment: "secret" } },
      { stage: "input" },
    );

    expect(decision.decisive?.policyName).toBe("high-severity");
  });

  it("breaks an exact tie with block beating redact", async () => {
    await seedCompany();
    await insertPolicy({
      name: "tie-redact",
      scopeType: "company",
      severity: "medium",
      action: "redact",
    });
    await insertPolicy({
      name: "tie-block",
      scopeType: "company",
      severity: "medium",
      action: "block",
    });

    const service = guardrailService(db);
    const decision = await service.applyGuardrails(
      { companyId, agentId, text: "secret", fields: { comment: "secret" } },
      { stage: "input" },
    );

    expect(decision.action).toBe("block");
    expect(decision.decisive?.policyName).toBe("tie-block");
  });

  it("allows everything when the policy set is empty", async () => {
    await seedCompany();
    const service = guardrailService(db);
    const decision = await service.applyGuardrails(
      { companyId, agentId, text: "patient@example.com", fields: { comment: "patient@example.com" } },
      { stage: "input" },
    );
    expect(decision).toMatchObject({ action: "allow", decisive: null, matches: [] });
    expect(decision.redactedText).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Matcher kinds
  // -------------------------------------------------------------------------

  it("matches a pii policy on an email and redacts it in place", async () => {
    await seedCompany();
    await insertPolicy({
      name: "email-policy",
      kind: "pii",
      matcher: { kind: "pii", piiTypes: ["email"] },
      action: "redact",
      stage: "output",
    });

    const service = guardrailService(db);
    const result = await service.applyTextGuardrails(
      {
        companyId,
        agentId,
        text: "Patient email is patient@example.com for follow up",
        fields: { comment: "Patient email is patient@example.com for follow up" },
      },
      { stage: "output" },
    );

    expect(result.decision.action).toBe("redact");
    expect(result.text).not.toContain("patient@example.com");
    expect(result.text).toContain("***REDACTED***");
    expect(result.text).toContain("for follow up");
  });

  it("matches a secret policy on a bearer token and redacts it", async () => {
    await seedCompany();
    await insertPolicy({
      name: "secret-policy",
      kind: "secret",
      matcher: { kind: "secret", secretTypes: ["bearer_token"] },
      action: "redact",
      stage: "output",
    });

    const service = guardrailService(db);
    const result = await service.applyTextGuardrails(
      {
        companyId,
        agentId,
        text: "call with Bearer abcdefghijklmnop123456",
        fields: { comment: "call with Bearer abcdefghijklmnop123456" },
      },
      { stage: "output" },
    );

    expect(result.decision.action).toBe("redact");
    expect(result.text).not.toContain("abcdefghijklmnop123456");
  });

  it("matches a restricted_action policy on the tool name", async () => {
    await seedCompany();
    await insertPolicy({
      name: "no-gmail",
      kind: "restricted_action",
      matcher: { kind: "restricted_action", toolNames: ["google_workspace:gmail_read"] },
      action: "block",
      stage: "action",
    });

    const service = guardrailService(db);
    const outcome = await service.enforceToolAction({
      companyId,
      toolName: "google_workspace:gmail_read",
      connectorType: "google_workspace",
      parameters: { query: "medical" },
      agentId,
      park: () => {},
    });

    expect(outcome.outcome).toBe("block");
    expect(outcome.decision.decisive?.policyName).toBe("no-gmail");
  });

  it("matches a restricted_action policy on an argument path", async () => {
    await seedCompany();
    await insertPolicy({
      name: "no-pii-args",
      kind: "restricted_action",
      matcher: {
        kind: "restricted_action",
        argumentPatterns: [{ path: "recipient.email", pattern: "@" }],
      },
      action: "require_approval",
      stage: "action",
    });

    const service = guardrailService(db);
    const outcome = await service.enforceToolAction({
      companyId,
      toolName: "google_workspace:gmail_send",
      connectorType: "google_workspace",
      parameters: { recipient: { email: "patient@example.com" } },
      agentId,
      park: () => {},
    });

    expect(outcome.outcome).toBe("require_approval");
  });

  it("matches a regex policy on the supplied pattern", async () => {
    await seedCompany();
    await insertPolicy({
      name: "regex-policy",
      kind: "regex",
      matcher: { kind: "regex", patterns: ["ICD-10\\s+[A-Z]\\d"] },
      action: "block",
      stage: "output",
    });

    const service = guardrailService(db);
    const decision = await service.applyGuardrails(
      {
        companyId,
        agentId,
        text: "diagnosis recorded as ICD-10 E11.9",
        fields: { comment: "diagnosis recorded as ICD-10 E11.9" },
      },
      { stage: "output" },
    );

    expect(decision.action).toBe("block");
  });

  it("matches an allowlist policy on a value that is not listed", async () => {
    await seedCompany();
    await insertPolicy({
      name: "allowlist-policy",
      kind: "allowlist",
      matcher: { kind: "allowlist", values: ["alpha", "beta"] },
      action: "block",
      stage: "output",
    });

    const service = guardrailService(db);
    const allowed = await service.applyGuardrails(
      { companyId, agentId, text: "alpha", fields: { comment: "alpha" } },
      { stage: "output" },
    );
    expect(allowed.action).toBe("allow");

    const blocked = await service.applyGuardrails(
      { companyId, agentId, text: "gamma", fields: { comment: "gamma" } },
      { stage: "output" },
    );
    expect(blocked.action).toBe("block");
  });

  it("evaluates a policy directly without touching the database", async () => {
    const match = evaluatePolicy(
      {
        id: "policy-1",
        companyId,
        scopeType: "company",
        scopeId: null,
        stage: "input",
        name: "direct-eval",
        description: null,
        kind: "pii",
        matcher: { kind: "pii", piiTypes: ["email"] },
        action: "redact",
        severity: "medium",
        enabled: true,
        version: 3,
      },
      {
        companyId,
        text: "write to a@b.com",
        fields: { comment: "write to a@b.com" },
      },
    );

    expect(match).toMatchObject({
      policyId: "policy-1",
      policyName: "direct-eval",
      action: "redact",
      policyVersion: 3,
    });
    expect(match?.excerpt).not.toContain("a@b.com");
  });

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  it("records a violation and an activity log entry for a non-allow decision", async () => {
    await seedCompany();
    const policy = await insertPolicy({
      name: "audited-policy",
      kind: "regex",
      matcher: { kind: "regex", patterns: ["classified"] },
      action: "block",
      stage: "output",
    });

    const service = guardrailService(db);
    await service.applyGuardrails(
      { companyId, agentId, text: "classified material", fields: { comment: "classified material" } },
      {
        stage: "output",
        violation: { subjectKind: "issue_comment", subjectId: "issue-1" },
      },
    );

    const [violation] = await db
      .select()
      .from(guardrailViolations)
      .where(eq(guardrailViolations.companyId, companyId));
    expect(violation).toMatchObject({
      policyId: policy.id,
      policyVersion: 1,
      stage: "output",
      actionTaken: "block",
      subjectKind: "issue_comment",
      subjectId: "issue-1",
      actorAgentId: agentId,
      resolved: false,
    });

    const entries = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));
    expect(entries.some((entry) => entry.action === "guardrail.block")).toBe(true);
  });

  it("does not record a violation for an allow decision", async () => {
    await seedCompany();
    await insertPolicy({
      name: "no-match-policy",
      kind: "regex",
      matcher: { kind: "regex", patterns: ["classified"] },
      action: "block",
      stage: "output",
    });

    const service = guardrailService(db);
    await service.applyGuardrails(
      { companyId, agentId, text: "ordinary text", fields: { comment: "ordinary text" } },
      {
        stage: "output",
        violation: { subjectKind: "issue_comment", subjectId: "issue-1" },
      },
    );

    const violations = await db
      .select()
      .from(guardrailViolations)
      .where(eq(guardrailViolations.companyId, companyId));
    expect(violations).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Enforcement points
  // -------------------------------------------------------------------------

  it("blocks a tool result and returns the redacted content for a redact decision", async () => {
    await seedCompany();
    await insertPolicy({
      name: "result-block",
      kind: "pii",
      matcher: { kind: "pii", piiTypes: ["email"] },
      action: "block",
      stage: "input",
    });

    const service = guardrailService(db);
    const outcome = await service.enforceToolResult({
      companyId,
      toolName: "google_workspace:gmail_read",
      content: "client medical detail for patient@example.com",
      agentId,
    });

    expect(outcome.outcome).toBe("block");
  });

  it("parks a tool call that requires approval", async () => {
    await seedCompany();
    await insertPolicy({
      name: "approval-policy",
      kind: "restricted_action",
      matcher: { kind: "restricted_action", toolNames: ["google_workspace:gmail_send"] },
      action: "require_approval",
      stage: "action",
    });

    const service = guardrailService(db);
    let parked: { approvalId: string | null } | null = null;
    const outcome = await service.enforceToolAction({
      companyId,
      toolName: "google_workspace:gmail_send",
      connectorType: "google_workspace",
      parameters: { to: "patient@example.com" },
      agentId,
      park: (value) => {
        parked = value;
        value.approvalId = "approval-1";
      },
    });

    expect(outcome.outcome).toBe("require_approval");
    expect(outcome.approvalId).toBe("approval-1");
    expect(parked?.approvalId).toBe("approval-1");
  });

  it("leaves a tool call alone when no policy applies", async () => {
    await seedCompany();
    await insertPolicy({
      name: "unrelated-policy",
      kind: "restricted_action",
      matcher: { kind: "restricted_action", toolNames: ["google_workspace:gmail_send"] },
      action: "block",
      stage: "action",
    });

    const service = guardrailService(db);
    const outcome = await service.enforceToolAction({
      companyId,
      toolName: "google_workspace:gmail_read",
      connectorType: "google_workspace",
      parameters: {},
      agentId,
      park: () => {},
    });

    expect(outcome.outcome).toBe("allow");
  });

  it("does not apply an input-stage policy to an output-stage subject", async () => {
    await seedCompany();
    await insertPolicy({
      name: "input-only",
      kind: "regex",
      matcher: { kind: "regex", patterns: ["classified"] },
      action: "block",
      stage: "input",
    });

    const service = guardrailService(db);
    const decision = await service.applyGuardrails(
      { companyId, agentId, text: "classified", fields: { comment: "classified" } },
      { stage: "output" },
    );

    expect(decision.action).toBe("allow");
  });
});
