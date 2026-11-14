import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  principalPermissionGrants,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  guardrailPolicies,
  guardrailViolations,
} from "@paperclipai/db";
import {
  guardrailService,
  evaluatePolicy,
  mapToolResultText,
  redactWithMatchers,
  toolResultText,
  type EffectivePolicy,
} from "../services/guardrails.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * A policy record built in memory, for the pure matcher tests that do not
 * need the database.
 */
function policy(overrides: Partial<EffectivePolicy["policy"]> = {}): EffectivePolicy["policy"] {
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    scopeType: "company",
    scopeId: null,
    stage: "input",
    name: "Test policy",
    description: null,
    kind: "regex",
    matcher: { kind: "regex", patterns: ["secret"] },
    action: "block",
    severity: "high",
    enabled: true,
    version: 1,
    ...overrides,
  };
}

describe("guardrail policy evaluation", () => {
  describe("matcher kinds", () => {
    it("matches a pii policy on an email address", () => {
      const match = evaluatePolicy(
        policy({ kind: "pii", matcher: { kind: "pii" } }),
        { companyId: "c1", text: "reach me at jane.doe@example.com please" },
      );
      expect(match).not.toBeNull();
      expect(match?.kind).toBe("pii");
    });

    it("does not match a pii policy on clean text", () => {
      const match = evaluatePolicy(
        policy({ kind: "pii", matcher: { kind: "pii" } }),
        { companyId: "c1", text: "the build is green and the tests pass" },
      );
      expect(match).toBeNull();
    });

    it("narrows a pii policy to the requested families", () => {
      const match = evaluatePolicy(
        policy({
          kind: "pii",
          matcher: { kind: "pii", piiTypes: ["email"] },
        }),
        { companyId: "c1", text: "call 555-123-4567 today" },
      );
      expect(match).toBeNull();
    });

    it("matches a secret policy on a bearer token", () => {
      const match = evaluatePolicy(
        policy({ kind: "secret", matcher: { kind: "secret" } }),
        { companyId: "c1", text: "Authorization: Bearer abc123def456ghi" },
      );
      expect(match).not.toBeNull();
      expect(match?.kind).toBe("secret");
    });

    it("matches a restricted_action policy on the tool name", () => {
      const match = evaluatePolicy(
        policy({
          kind: "restricted_action",
          matcher: { kind: "restricted_action", toolNames: ["gmail:send"] },
        }),
        { companyId: "c1", toolName: "gmail:send" },
      );
      expect(match).not.toBeNull();
      expect(match?.matchedField).toBe("tool_name");
    });

    it("does not match a restricted_action policy on a different tool", () => {
      const match = evaluatePolicy(
        policy({
          kind: "restricted_action",
          matcher: { kind: "restricted_action", toolNames: ["gmail:send"] },
        }),
        { companyId: "c1", toolName: "gmail:read" },
      );
      expect(match).toBeNull();
    });

    it("matches a restricted_action policy on the connector type", () => {
      const match = evaluatePolicy(
        policy({
          kind: "restricted_action",
          matcher: { kind: "restricted_action", connectorTypes: ["google_workspace"] },
        }),
        { companyId: "c1", toolName: "gmail:read", connectorType: "google_workspace" },
      );
      expect(match).not.toBeNull();
    });

    it("matches a restricted_action policy on an argument path", () => {
      const match = evaluatePolicy(
        policy({
          kind: "restricted_action",
          matcher: {
            kind: "restricted_action",
            argumentPatterns: [{ path: "recipient", pattern: "@external\\.com$" }],
          },
        }),
        {
          companyId: "c1",
          toolName: "gmail:send",
          toolArguments: { recipient: "partner@external.com" },
        },
      );
      expect(match).not.toBeNull();
      expect(match?.matchedField).toBe("tool_args");
    });

    it("skips an argument pattern that does not compile instead of throwing", () => {
      const match = evaluatePolicy(
        policy({
          kind: "restricted_action",
          matcher: {
            kind: "restricted_action",
            argumentPatterns: [{ path: "recipient", pattern: "([unclosed" }],
          },
        }),
        {
          companyId: "c1",
          toolName: "gmail:send",
          toolArguments: { recipient: "partner@external.com" },
        },
      );
      expect(match).toBeNull();
    });

    it("matches an allowlist policy when the value is not listed", () => {
      const match = evaluatePolicy(
        policy({
          kind: "allowlist",
          matcher: { kind: "allowlist", values: ["staging"] },
        }),
        { companyId: "c1", text: "production" },
      );
      expect(match).not.toBeNull();
    });

    it("does not match an allowlist policy when the value is listed", () => {
      const match = evaluatePolicy(
        policy({
          kind: "allowlist",
          matcher: { kind: "allowlist", values: ["staging"] },
        }),
        { companyId: "c1", text: "staging" },
      );
      expect(match).toBeNull();
    });

    it("restricts a regex policy to the named field", () => {
      const withField = evaluatePolicy(
        policy({
          matcher: { kind: "regex", patterns: ["forbidden"], fields: ["comment"] },
        }),
        { companyId: "c1", text: "forbidden", fields: { comment: "forbidden" } },
      );
      expect(withField).not.toBeNull();

      const withoutField = evaluatePolicy(
        policy({
          matcher: { kind: "regex", patterns: ["forbidden"], fields: ["comment"] },
        }),
        { companyId: "c1", text: "forbidden", fields: { title: "forbidden" } },
      );
      expect(withoutField).toBeNull();
    });
  });
});

describeEmbeddedPostgres("guardrail service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-guardrails-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(guardrailViolations);
    await db.delete(guardrailPolicies);
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    companyId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name: `Guardrails ${companyId}`,
      issuePrefix: `GR${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(authUsers).values({
      id: `user-${randomUUID()}`,
      name: "Owner",
      email: `owner-${companyId}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    return companyId;
  }

  it("allows when no policies exist", async () => {
    await seedCompany();
    const guardrails = guardrailService(db);
    const decision = await guardrails.applyGuardrails(
      { companyId, text: "anything at all" },
      { stage: "input" },
    );
    expect(decision.action).toBe("allow");
    expect(decision.matches).toHaveLength(0);
    expect(decision.decisive).toBeNull();
  });

  it("blocks and records a violation when a policy matches", async () => {
    await seedCompany();
    const guardrails = guardrailService(db);
    await guardrails.createPolicy(companyId, {
      scopeType: "company",
      scopeId: null,
      stage: "input",
      name: "Block secrets",
      kind: "secret",
      matcher: { kind: "secret" },
      action: "block",
      severity: "critical",
    });

    const decision = await guardrails.applyGuardrails(
      { companyId, text: "here is Bearer abc123def456ghi789" },
      { stage: "input", violation: { subjectKind: "wake_context" } },
    );

    expect(decision.action).toBe("block");
    expect(decision.decisive?.policyName).toBe("Block secrets");

    const violations = await guardrails.listViolations(companyId);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.actionTaken).toBe("block");
    expect(violations[0]?.stage).toBe("input");
    expect(violations[0]?.subjectKind).toBe("wake_context");
  });

  it("redacts the matched span and does not record an allow", async () => {
    await seedCompany();
    const guardrails = guardrailService(db);
    await guardrails.createPolicy(companyId, {
      scopeType: "company",
      scopeId: null,
      stage: "input",
      name: "Redact emails",
      kind: "pii",
      matcher: { kind: "pii", piiTypes: ["email"] },
      action: "redact",
      severity: "medium",
    });

    const decision = await guardrails.applyGuardrails(
      { companyId, text: "mail me at jane.doe@example.com" },
      { stage: "input", violation: { subjectKind: "wake_context" } },
    );

    expect(decision.action).toBe("redact");
    expect(decision.redactedText).not.toContain("jane.doe@example.com");
    expect(decision.redactedText).toContain("***REDACTED***");
  });

  it("only applies policies scoped to the subject's own scopes", async () => {
    await seedCompany();
    const guardrails = guardrailService(db);
    const otherAgentId = randomUUID();

    await guardrails.createPolicy(companyId, {
      scopeType: "agent",
      scopeId: otherAgentId,
      stage: "input",
      name: "Scoped to another agent",
      kind: "regex",
      matcher: { kind: "regex", patterns: ["secret"] },
      action: "block",
      severity: "high",
    });

    const decision = await guardrails.applyGuardrails(
      { companyId, agentId: randomUUID(), text: "a secret value" },
      { stage: "input" },
    );
    expect(decision.action).toBe("allow");
  });

  it("applies an agent-scoped policy to that agent", async () => {
    await seedCompany();
    const guardrails = guardrailService(db);
    const agentId = randomUUID();

    await guardrails.createPolicy(companyId, {
      scopeType: "agent",
      scopeId: agentId,
      stage: "input",
      name: "Scoped to one agent",
      kind: "regex",
      matcher: { kind: "regex", patterns: ["secret"] },
      action: "block",
      severity: "high",
    });

    const decision = await guardrails.applyGuardrails(
      { companyId, agentId, text: "a secret value" },
      { stage: "input" },
    );
    expect(decision.action).toBe("block");
  });

  it("prefers the most specific scope when two policies conflict", async () => {
    await seedCompany();
    const guardrails = guardrailService(db);
    const agentId = randomUUID();

    await guardrails.createPolicy(companyId, {
      scopeType: "company",
      scopeId: null,
      stage: "input",
      name: "Company-wide redact",
      kind: "regex",
      matcher: { kind: "regex", patterns: ["secret"] },
      action: "redact",
      severity: "high",
    });
    await guardrails.createPolicy(companyId, {
      scopeType: "agent",
      scopeId: agentId,
      stage: "input",
      name: "Agent block",
      kind: "regex",
      matcher: { kind: "regex", patterns: ["secret"] },
      action: "block",
      severity: "high",
    });

    const decision = await guardrails.applyGuardrails(
      { companyId, agentId, text: "a secret value" },
      { stage: "input" },
    );
    expect(decision.action).toBe("block");
    expect(decision.decisive?.scopeType).toBe("agent");
    expect(decision.matches).toHaveLength(2);
  });

  it("ignores a policy from another company", async () => {
    await seedCompany();
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: `Other ${otherCompanyId}`,
      issuePrefix: `OT${otherCompanyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    const guardrails = guardrailService(db);
    await guardrails.createPolicy(otherCompanyId, {
      scopeType: "company",
      scopeId: null,
      stage: "input",
      name: "Other company block",
      kind: "regex",
      matcher: { kind: "regex", patterns: ["secret"] },
      action: "block",
      severity: "critical",
    });

    const decision = await guardrails.applyGuardrails(
      { companyId, text: "a secret value" },
      { stage: "input" },
    );
    expect(decision.action).toBe("allow");
  });

  it("ignores a disabled policy", async () => {
    await seedCompany();
    const guardrails = guardrailService(db);
    await guardrails.createPolicy(companyId, {
      scopeType: "company",
      scopeId: null,
      stage: "input",
      name: "Disabled",
      kind: "regex",
      matcher: { kind: "regex", patterns: ["secret"] },
      action: "block",
      severity: "critical",
      enabled: false,
    });

    const decision = await guardrails.applyGuardrails(
      { companyId, text: "a secret value" },
      { stage: "input" },
    );
    expect(decision.action).toBe("allow");
  });

  it("does not apply an input-stage policy to the action stage", async () => {
    await seedCompany();
    const guardrails = guardrailService(db);
    await guardrails.createPolicy(companyId, {
      scopeType: "company",
      scopeId: null,
      stage: "input",
      name: "Input only",
      kind: "regex",
      matcher: { kind: "regex", patterns: ["secret"] },
      action: "block",
      severity: "critical",
    });

    const decision = await guardrails.applyGuardrails(
      { companyId, text: "a secret value" },
      { stage: "action" },
    );
    expect(decision.action).toBe("allow");
  });
});

describe("tool result text helpers", () => {
  const mcp = { content: [{ type: "text", text: "key sk-live-123 for asha@example.com" }, { type: "image", data: "xx" }], isError: false };

  it("reads text from strings, { content: string } and MCP content parts", () => {
    expect(toolResultText("plain")).toBe("plain");
    expect(toolResultText({ content: "wrapped" })).toBe("wrapped");
    expect(toolResultText(mcp)).toBe("key sk-live-123 for asha@example.com");
    expect(toolResultText({ rows: [{ email: "a@b.co" }] })).toContain("a@b.co");
    expect(toolResultText(null)).toBe("");
  });

  it("redacts inside the result's own shape", () => {
    const redact = (text: string) =>
      redactWithMatchers([{ kind: "pii", piiTypes: ["email"] }, { kind: "regex", patterns: ["sk-live-\\d+"] }], text);
    const out = mapToolResultText(mcp, redact) as typeof mcp;
    expect(out.content[0]).toMatchObject({ type: "text" });
    expect((out.content[0] as { text: string }).text).not.toMatch(/asha@example\.com|sk-live-123/);
    expect(out.content[1]).toEqual({ type: "image", data: "xx" });
    expect(out.isError).toBe(false);
    expect(mapToolResultText({ content: "mail a@b.co" }, redact)).toEqual({ content: expect.not.stringContaining("a@b.co") });
    expect(mapToolResultText({ rows: [{ email: "a@b.co" }] }, redact)).toEqual({ rows: [{ email: expect.not.stringContaining("a@b.co") }] });
  });
});
