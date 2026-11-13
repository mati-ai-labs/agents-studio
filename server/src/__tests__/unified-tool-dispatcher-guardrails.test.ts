import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  approvals,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  guardrailPolicies,
  guardrailViolations,
  principalPermissionGrants,
} from "@paperclipai/db";
import type { ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import {
  createUnifiedToolDispatcher,
  GuardrailBlockedError,
} from "../services/unified-tool-dispatcher.js";
import { guardrailService } from "../services/guardrails.js";
import type { ConnectorToolDispatcher } from "../services/connector-tool-dispatcher.js";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * A plugin dispatcher that records whether it was reached. If a guardrail
 * blocks the call, the plugin must never run.
 */
function stubPluginDispatcher(result: ToolResult = { content: "ok" }) {
  const calls: Array<{ name: string; parameters: unknown }> = [];
  const dispatcher = {
    initialize: async () => {},
    teardown: () => {},
    listToolsForAgent: () => [],
    getTool: () => null,
    getToolDescriptor: () => null,
    listTools: () => [],
    toolCount: () => ({ plugins: 0, connectors: 0, total: 0 }),
    executeTool: async (name: string, parameters: unknown) => {
      calls.push({ name, parameters });
      return { toolName: name, pluginId: "plugin-1", result };
    },
  } as unknown as PluginToolDispatcher;
  return { dispatcher, calls };
}

function stubConnectorDispatcher() {
  const calls: Array<{ name: string; companyId: string }> = [];
  const dispatcher = {
    initialize: async () => {},
    teardown: () => {},
    listTools: () => [
      {
        name: "gmail:send",
        displayName: "Send email",
        description: "Send an email",
        parametersSchema: {},
        connectorType: "google_workspace",
      },
    ],
    getTool: () => null,
    toolCount: () => ({ plugins: 0, connectors: 0, total: 0 }),
    executeTool: async (name: string, _parameters: unknown, companyId: string) => {
      calls.push({ name, companyId });
      return {
        connectorType: "google_workspace",
        toolName: name,
        result: { content: "sent" },
      };
    },
  } as unknown as ConnectorToolDispatcher;
  return { dispatcher, calls };
}

describeEmbeddedPostgres("unified tool dispatcher guardrails", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dispatcher-guardrails-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(guardrailViolations);
    await db.delete(guardrailPolicies);
    await db.delete(approvals);
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
    await db.insert(companies).values({
      id: companyId,
      name: `Dispatcher ${companyId}`,
      issuePrefix: `DS${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    return companyId;
  }

  /**
   * Seeds an agent so the approvals row can reference it — the approvals table
   * has a foreign key on `requested_by_agent_id`.
   */
  let seededAgentId = "";

  async function seedAgent() {
    const agentId = randomUUID();
    seededAgentId = agentId;
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Runner",
      role: "worker",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    return agentId;
  }

  function runContext(overrides: Partial<ToolRunContext> = {}): ToolRunContext {
    return {
      agentId: seededAgentId,
      runId: randomUUID(),
      companyId,
      projectId: randomUUID(),
      ...overrides,
    };
  }

  /**
   * Builds a dispatcher with the connector tool cache primed, so the connector
   * path is selected the same way it is in production.
   */
  async function unifiedWith(pluginResult?: ToolResult) {
    const { dispatcher: pluginDispatcher, calls: pluginCalls } = stubPluginDispatcher(pluginResult);
    const { dispatcher: connectorDispatcher, calls: connectorCalls } = stubConnectorDispatcher();
    const unified = createUnifiedToolDispatcher({
      db,
      pluginDispatcher,
      connectorDispatcher,
    });
    await unified.initialize();
    return { unified, pluginCalls, connectorCalls };
  }

  it("blocks the call when no company id can be resolved", async () => {
    await seedCompany();
    await seedAgent();
    const { unified, pluginCalls } = await unifiedWith();

    // The run context has no company id and the parameters carry none either,
    // so there is no policy set to evaluate against. The call must fail
    // closed rather than be allowed by default.
    const context = runContext({ companyId: "" as string });
    await expect(
      unified.executeTool("some:tool", { value: 1 }, context),
    ).rejects.toBeInstanceOf(GuardrailBlockedError);
    expect(pluginCalls).toHaveLength(0);
  });

  it("uses the company id from the parameters when the run context has none", async () => {
    await seedCompany();
    await seedAgent();
    const { unified, pluginCalls } = await unifiedWith();

    const context = runContext({ companyId: "" as string });
    const result = await unified.executeTool("some:tool", { companyId, value: 1 }, context);
    expect(result.source).toBe("plugin");
    expect(pluginCalls).toHaveLength(1);
  });

  it("blocks a tool call that matches a restricted_action policy", async () => {
    await seedCompany();
    await seedAgent();
    const guardrails = guardrailService(db);
    await guardrails.createPolicy(companyId, {
      scopeType: "company",
      scopeId: null,
      stage: "action",
      name: "No sending email",
      kind: "restricted_action",
      matcher: { kind: "restricted_action", toolNames: ["gmail:send"] },
      action: "block",
      severity: "critical",
    });

    const { unified, pluginCalls, connectorCalls } = await unifiedWith();

    await expect(
      unified.executeTool("gmail:send", { to: "x@example.com" }, runContext()),
    ).rejects.toBeInstanceOf(GuardrailBlockedError);
    // Neither the connector nor the plugin path may run.
    expect(connectorCalls).toHaveLength(0);
    expect(pluginCalls).toHaveLength(0);

    const violations = await guardrails.listViolations(companyId);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.actionTaken).toBe("block");
    expect(violations[0]?.stage).toBe("action");
  });

  it("does not apply a policy from another company to the call", async () => {
    await seedCompany();
    await seedAgent();
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
      stage: "action",
      name: "Other company block",
      kind: "restricted_action",
      matcher: { kind: "restricted_action", toolNames: ["gmail:send"] },
      action: "block",
      severity: "critical",
    });

    const { unified, connectorCalls } = await unifiedWith();

    const result = await unified.executeTool("gmail:send", { to: "x@example.com" }, runContext());
    expect(result.source).toBe("connector");
    expect(connectorCalls).toHaveLength(1);
    expect(connectorCalls[0]?.companyId).toBe(companyId);
  });

  it("parks a require_approval tool call on the approvals queue", async () => {
    await seedCompany();
    const agentId = await seedAgent();
    const guardrails = guardrailService(db);
    await guardrails.createPolicy(companyId, {
      scopeType: "company",
      scopeId: null,
      stage: "action",
      name: "Ask before sending",
      kind: "restricted_action",
      matcher: { kind: "restricted_action", toolNames: ["gmail:send"] },
      action: "require_approval",
      severity: "high",
    });

    const { unified, pluginCalls, connectorCalls } = await unifiedWith();

    const result = await unified.executeTool(
      "gmail:send",
      { to: "x@example.com" },
      runContext({ agentId }),
    );
    expect(result.result.content).toContain("requires approval");
    expect(connectorCalls).toHaveLength(0);
    expect(pluginCalls).toHaveLength(0);

    const rows = await db.select().from(approvals);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("guardrail_action");
    expect(rows[0]?.status).toBe("pending");
  });

  it("redacts a secret in the tool result before it reaches the agent", async () => {
    await seedCompany();
    await seedAgent();
    const guardrails = guardrailService(db);
    await guardrails.createPolicy(companyId, {
      scopeType: "company",
      scopeId: null,
      stage: "input",
      name: "Redact secrets in results",
      kind: "secret",
      matcher: { kind: "secret" },
      action: "redact",
      severity: "medium",
    });

    const { unified } = await unifiedWith({
      content: "the token is Bearer abc123def456ghi789",
    });

    const result = await unified.executeTool("some:tool", {}, runContext());
    expect(result.result.content).not.toContain("abc123def456ghi789");
    expect(result.result.content).toContain("***REDACTED***");
  });

  it("blocks a tool result that matches a block policy", async () => {
    await seedCompany();
    await seedAgent();
    const guardrails = guardrailService(db);
    await guardrails.createPolicy(companyId, {
      scopeType: "company",
      scopeId: null,
      stage: "input",
      name: "Block leaky results",
      kind: "secret",
      matcher: { kind: "secret" },
      action: "block",
      severity: "critical",
    });

    const { unified } = await unifiedWith({
      content: "the token is Bearer abc123def456ghi789",
    });

    await expect(unified.executeTool("some:tool", {}, runContext())).rejects.toBeInstanceOf(
      GuardrailBlockedError,
    );
  });

  it("runs the tool when no policy matches", async () => {
    await seedCompany();
    await seedAgent();
    const { unified, pluginCalls } = await unifiedWith();

    const result = await unified.executeTool("some:tool", { value: 1 }, runContext());
    expect(result.source).toBe("plugin");
    expect(pluginCalls).toHaveLength(1);
  });

  /**
   * Marks an approval as decided by a human, the way the approvals service
   * does when a person resolves one.
   */
  async function resolveApproval(
    approvalId: string,
    status: "approved" | "rejected",
  ) {
    await db
      .update(approvals)
      .set({ status, decidedByUserId: "user-1", decidedAt: new Date() })
      .where(eq(approvals.id, approvalId));
  }

  /**
   * Seeds a policy that parks every `gmail:send` call for approval.
   */
  async function seedRequireApprovalPolicy() {
    const guardrails = guardrailService(db);
    await guardrails.createPolicy(companyId, {
      scopeType: "company",
      scopeId: null,
      stage: "action",
      name: "Ask before sending",
      kind: "restricted_action",
      matcher: { kind: "restricted_action", toolNames: ["gmail:send"] },
      action: "require_approval",
      severity: "high",
    });
    return guardrails;
  }

  it("runs the parked call once a human approves it", async () => {
    await seedCompany();
    const agentId = await seedAgent();
    await seedRequireApprovalPolicy();

    const { unified, connectorCalls } = await unifiedWith();
    const context = runContext({ agentId });

    // The first call parks.
    const parked = await unified.executeTool("gmail:send", { to: "x@example.com" }, context);
    expect(parked.result.content).toContain("requires approval");
    expect(connectorCalls).toHaveLength(0);

    const rows = await db.select().from(approvals);
    expect(rows).toHaveLength(1);
    await resolveApproval(rows[0]!.id, "approved");

    // The retry runs the tool.
    const resumed = await unified.executeTool("gmail:send", { to: "x@example.com" }, context);
    expect(resumed.source).toBe("connector");
    expect(connectorCalls).toHaveLength(1);
  });

  it("cancels the parked call when a human rejects it", async () => {
    await seedCompany();
    const agentId = await seedAgent();
    await seedRequireApprovalPolicy();

    const { unified, connectorCalls } = await unifiedWith();
    const context = runContext({ agentId });

    const parked = await unified.executeTool("gmail:send", { to: "x@example.com" }, context);
    expect(parked.result.content).toContain("requires approval");

    const rows = await db.select().from(approvals);
    await resolveApproval(rows[0]!.id, "rejected");

    const cancelled = await unified.executeTool("gmail:send", { to: "x@example.com" }, context);
    expect(cancelled.result.content).toContain("rejected the approval");
    expect(connectorCalls).toHaveLength(0);
    // The rejected call is not parked a second time.
    expect(await db.select().from(approvals)).toHaveLength(1);
  });

  it("does not run a call whose approval was for different arguments", async () => {
    await seedCompany();
    const agentId = await seedAgent();
    await seedRequireApprovalPolicy();

    const { unified, connectorCalls } = await unifiedWith();
    const context = runContext({ agentId });

    await unified.executeTool("gmail:send", { to: "x@example.com" }, context);
    const rows = await db.select().from(approvals);
    await resolveApproval(rows[0]!.id, "approved");

    // Different arguments, so the approval does not cover this call.
    const result = await unified.executeTool("gmail:send", { to: "y@example.com" }, context);
    expect(result.result.content).toContain("requires approval");
    expect(connectorCalls).toHaveLength(0);
  });

  it("does not reuse an approval that was already spent", async () => {
    await seedCompany();
    const agentId = await seedAgent();
    await seedRequireApprovalPolicy();

    const { unified, connectorCalls } = await unifiedWith();
    const context = runContext({ agentId });

    await unified.executeTool("gmail:send", { to: "x@example.com" }, context);
    const rows = await db.select().from(approvals);
    await resolveApproval(rows[0]!.id, "approved");

    // The first retry spends the approval.
    const first = await unified.executeTool("gmail:send", { to: "x@example.com" }, context);
    expect(first.source).toBe("connector");
    expect(connectorCalls).toHaveLength(1);

    // The second retry must park again rather than ride on the same approval.
    const second = await unified.executeTool("gmail:send", { to: "x@example.com" }, context);
    expect(second.result.content).toContain("requires approval");
    expect(connectorCalls).toHaveLength(1);
  });

  it("does not let another agent ride on an approval", async () => {
    await seedCompany();
    const agentId = await seedAgent();
    await seedRequireApprovalPolicy();

    const { unified, connectorCalls } = await unifiedWith();

    await unified.executeTool("gmail:send", { to: "x@example.com" }, runContext({ agentId }));
    const rows = await db.select().from(approvals);
    await resolveApproval(rows[0]!.id, "approved");

    // A different agent must not inherit the first agent's approval.
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "Other",
      role: "worker",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const result = await unified.executeTool(
      "gmail:send",
      { to: "x@example.com" },
      runContext({ agentId: otherAgentId }),
    );
    expect(result.result.content).toContain("requires approval");
    expect(connectorCalls).toHaveLength(0);
  });

  it("does not queue a second approval while the first is still pending", async () => {
    await seedCompany();
    const agentId = await seedAgent();
    await seedRequireApprovalPolicy();

    const { unified } = await unifiedWith();
    const context = runContext({ agentId });

    await unified.executeTool("gmail:send", { to: "x@example.com" }, context);
    await unified.executeTool("gmail:send", { to: "x@example.com" }, context);

    expect(await db.select().from(approvals)).toHaveLength(1);
  });
});
