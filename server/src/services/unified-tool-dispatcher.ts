/**
 * UnifiedToolDispatcher — combines PluginToolDispatcher and ConnectorToolDispatcher
 * into a single entry point for agent tool listing and execution.
 *
 * Agents call `listTools` / `executeTool` on this dispatcher. The unified
 * dispatcher routes:
 *   - Connector tools (google_workspace:*, notion:*, linear:*) → ConnectorToolDispatcher
 *   - Plugin tools (namespace:toolName) → PluginToolDispatcher
 *
 * @see plugin-tool-dispatcher.ts
 * @see connector-tool-dispatcher.ts
 */
import type { Db } from "@paperclipai/db";
import type { ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { type AgentToolDescriptor as PluginAgentToolDescriptor } from "./plugin-tool-dispatcher.js";
import type { PluginToolDispatcher } from "./plugin-tool-dispatcher.js";
import type {
  ConnectorToolDispatcher,
  ConnectorToolDescriptor,
} from "./connector-tool-dispatcher.js";
import { guardrailService, GuardrailBlockedError } from "./guardrails.js";
import { approvalService } from "./approvals.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UnifiedAgentToolDescriptor {
  name: string;
  displayName: string;
  description: string;
  parametersSchema: Record<string, unknown>;
  source: "plugin" | "connector";
  ownerId: string;
}

export interface ToolExecutionResult {
  source: "plugin" | "connector";
  toolName: string;
  ownerId: string;
  result: ToolResult;
}

/**
 * Thrown when a guardrail policy blocks a tool call.
 *
 * The message is deliberately explicit: the agent is told which policy fired
 * so it can adapt rather than retry blindly.
 */
export { GuardrailBlockedError };

// ---------------------------------------------------------------------------
// Unified dispatcher
// ---------------------------------------------------------------------------

export interface UnifiedToolDispatcher {
  initialize(): Promise<void>;
  teardown(): void;
  listToolsForAgent(filter?: { pluginId?: string }): UnifiedAgentToolDescriptor[];
  getToolDescriptor(namespacedName: string): UnifiedAgentToolDescriptor | null;
  executeTool(
    namespacedName: string,
    parameters: unknown,
    runContext: ToolRunContext,
  ): Promise<ToolExecutionResult>;
  toolCount(): { plugins: number; connectors: number; total: number };
}

export interface CreateUnifiedToolDispatcherOptions {
  db: Db;
  pluginDispatcher: PluginToolDispatcher;
  connectorDispatcher: ConnectorToolDispatcher;
}

export function createUnifiedToolDispatcher(
  options: CreateUnifiedToolDispatcherOptions,
): UnifiedToolDispatcher {
  const { db, pluginDispatcher, connectorDispatcher } = options;
  const log = logger.child({ service: "unified-tool-dispatcher" });
  const guardrails = guardrailService(db);
  const approvals = approvalService(db);

  /** Cache of connector tool descriptors, refreshed on each listTools call */
  let connectorToolsCache: ConnectorToolDescriptor[] = [];

  /** Set of registered connector tool names for fast routing */
  const connectorToolNames = new Set<string>();

  function isConnectorTool(namespacedName: string): boolean {
    return connectorToolNames.has(namespacedName);
  }

  function refreshConnectorCache(): void {
    const tools = connectorDispatcher.listTools();
    connectorToolsCache = tools;
    connectorToolNames.clear();
    for (const t of tools) connectorToolNames.add(t.name);
  }

  function toAgentDescriptor(
    tool: ConnectorToolDescriptor,
  ): UnifiedAgentToolDescriptor {
    return {
      name: tool.name,
      displayName: tool.displayName,
      description: tool.description,
      parametersSchema: tool.parametersSchema,
      source: "connector",
      ownerId: tool.connectorType,
    };
  }

  async function initialize(): Promise<void> {
    refreshConnectorCache();
    await pluginDispatcher.initialize();
    await connectorDispatcher.initialize();
    log.info(
      {
        pluginTools: pluginDispatcher.toolCount(),
        connectorTools: connectorDispatcher.toolCount(),
      },
      "Unified tool dispatcher initialized",
    );
  }

  function teardown(): void {
    pluginDispatcher.teardown();
  }

  function listToolsForAgent(filter?: { pluginId?: string }): UnifiedAgentToolDescriptor[] {
    refreshConnectorCache();

    // Get plugin tools from plugin dispatcher (filter applies to plugin tools only)
    const pluginDescriptors = pluginDispatcher.listToolsForAgent(filter);
    const normalizedPlugin = pluginDescriptors.map((t) => ({
      name: t.name,
      displayName: t.displayName,
      description: t.description,
      parametersSchema: t.parametersSchema,
      ownerId: t.pluginId,
      source: "plugin" as const,
    }));

    // Convert connector descriptors
    const connectorDescriptors = connectorToolsCache.map(toAgentDescriptor);

    return [...normalizedPlugin, ...connectorDescriptors];
  }

  function getToolDescriptor(namespacedName: string): UnifiedAgentToolDescriptor | null {
    // Check plugin tools
    const pluginTool = pluginDispatcher.getTool(namespacedName);
    if (pluginTool) {
      return {
        name: pluginTool.namespacedName,
        displayName: pluginTool.displayName,
        description: pluginTool.description,
        parametersSchema: pluginTool.parametersSchema,
        source: "plugin",
        ownerId: pluginTool.pluginDbId,
      };
    }

    // Check connector tools
    refreshConnectorCache();
    const connectorTool = connectorDispatcher.getTool(namespacedName);
    if (connectorTool) {
      return toAgentDescriptor(connectorTool);
    }

    return null;
  }

  async function executeTool(
    namespacedName: string,
    parameters: unknown,
    runContext: ToolRunContext,
  ): Promise<ToolExecutionResult> {
    // Resolve the company id ONCE, at the top, before the connector/plugin
    // branch. The connector path reads it from the arguments, the plugin path
    // from the run context; resolving here means the guardrail policy lookup
    // and the dispatch that follows always agree on the company that owns the
    // action. A policy evaluated against the wrong company is a policy
    // evaluated against the wrong company.
    const contextCompanyId =
      typeof runContext.companyId === "string" ? runContext.companyId.trim() : "";
    const parameterCompanyId =
      typeof (parameters as Record<string, unknown> | null)?.companyId === "string"
        ? ((parameters as Record<string, unknown>).companyId as string).trim()
        : "";
    const companyId = contextCompanyId || parameterCompanyId || undefined;

    // Fail closed: without a company id there is no policy set to evaluate
    // against, so the call is blocked rather than silently allowed.
    if (!companyId) {
      throw new GuardrailBlockedError(
        `companyId could not be resolved for tool ${namespacedName}; the call was blocked`,
        {
          code: "guardrail_company_scope_unresolved",
          policyId: null,
          policyName: null,
          stage: "action",
          action: "block",
        },
      );
    }

    const guardrail = await evaluateActionGuardrail({
      namespacedName,
      parameters,
      runContext,
      companyId,
    });
    if (guardrail) return guardrail;

    // Try connector tools first (they use companyId from args)
    if (connectorToolNames.has(namespacedName)) {
      const result = await connectorDispatcher.executeTool(
        namespacedName,
        parameters,
        companyId,
      );
      return await applyInputGuardrail(
        {
          source: "connector",
          toolName: result.toolName,
          ownerId: result.connectorType,
          result: result.result,
        },
        { runContext, companyId },
      );
    }

    // Fall through to plugin tools
    const pluginResult = await pluginDispatcher.executeTool(
      namespacedName,
      parameters,
      runContext,
    );
    return await applyInputGuardrail(
      {
        source: "plugin",
        toolName: pluginResult.toolName,
        ownerId: pluginResult.pluginId,
        result: pluginResult.result,
      },
      { runContext, companyId },
    );
  }

  /**
   * Evaluates the `action`-stage policies against the tool call.
   *
   * Returns a result when the policy set demanded something other than
   * running the tool: a `block` throws, and a `require_approval` parks the
   * call on the approvals queue and returns an instruction to the agent.
   */
  async function evaluateActionGuardrail(input: {
    namespacedName: string;
    parameters: unknown;
    runContext: ToolRunContext;
    companyId: string;
  }): Promise<ToolExecutionResult | null> {
    const connectorType = connectorTypeFor(input.namespacedName);

    const outcome = await guardrails.enforceToolAction({
      companyId: input.companyId,
      toolName: input.namespacedName,
      connectorType,
      parameters: input.parameters,
      agentId: input.runContext.agentId,
      runId: input.runContext.runId,
      projectId: input.runContext.projectId,
      park: async (parked) => {
        const approval = await approvals.create(input.companyId, {
          type: "guardrail_action",
          requestedByAgentId: input.runContext.agentId,
          status: "pending",
          payload: {
            toolName: parked.toolName,
            connectorType: parked.connectorType,
            agentId: input.runContext.agentId,
            runId: input.runContext.runId,
            projectId: input.runContext.projectId,
            policyId: parked.policyId,
            policyName: parked.policyName,
            stage: parked.stage,
            parameters: parked.parameters,
          },
        });
        parked.approvalId = approval?.id ?? null;
        log.info(
          {
            companyId: input.companyId,
            tool: input.namespacedName,
            policyName: parked.policyName,
            approvalId: parked.approvalId,
          },
          "guardrail policy requires approval before this tool can run",
        );
      },
    });

    if (outcome.outcome === "allow") return null;

    if (outcome.outcome === "block") {
      throw new GuardrailBlockedError(
        `Tool ${input.namespacedName} was blocked by guardrail policy "${outcome.decision.decisive?.policyName ?? "unknown"}"`,
        {
          code: "guardrail_policy_blocked",
          policyId: outcome.decision.decisive?.policyId ?? null,
          policyName: outcome.decision.decisive?.policyName ?? null,
          stage: "action",
          action: "block",
        },
      );
    }

    const policyName = outcome.decision.decisive?.policyName ?? "unknown";
    return {
      source: connectorType ? "connector" : "plugin",
      toolName: input.namespacedName,
      ownerId: connectorType ?? "guardrail",
      result: {
        content:
          `Tool ${input.namespacedName} requires approval under guardrail policy "${policyName}". ` +
          `The call was not executed and is waiting for a human decision.`,
        data: {
          guardrail: {
            status: "require_approval",
            policyId: outcome.decision.decisive?.policyId ?? null,
            policyName,
            stage: "action",
            approvalId: outcome.approvalId,
          },
        },
      },
    };
  }

  /**
   * Applies the `input`-stage policies to the value the tool returned.
   *
   * A tool result is the highest-risk input in the system — it comes from
   * outside the studio — so the result is checked before it reaches the
   * agent.
   */
  async function applyInputGuardrail(
    execution: ToolExecutionResult,
    context: { runContext: ToolRunContext; companyId: string },
  ): Promise<ToolExecutionResult> {
    const content = execution.result.content;
    if (typeof content !== "string" || content.length === 0) return execution;

    const outcome = await guardrails.enforceToolResult({
      companyId: context.companyId,
      toolName: execution.toolName,
      content,
      agentId: context.runContext.agentId,
      runId: context.runContext.runId,
      projectId: context.runContext.projectId,
      park: async (parked) => {
        const approval = await approvals.create(context.companyId, {
          type: "guardrail_action",
          requestedByAgentId: context.runContext.agentId,
          status: "pending",
          payload: {
            toolName: parked.toolName,
            agentId: context.runContext.agentId,
            runId: context.runContext.runId,
            projectId: context.runContext.projectId,
            policyId: parked.policyId,
            policyName: parked.policyName,
            stage: parked.stage,
          },
        });
        parked.approvalId = approval?.id ?? null;
      },
    });

    if (outcome.outcome === "allow") return execution;

    if (outcome.outcome === "block") {
      throw new GuardrailBlockedError(
        `The result of ${execution.toolName} was blocked by guardrail policy "${outcome.decision.decisive?.policyName ?? "unknown"}"`,
        {
          code: "guardrail_result_blocked",
          policyId: outcome.decision.decisive?.policyId ?? null,
          policyName: outcome.decision.decisive?.policyName ?? null,
          stage: "input",
          action: "block",
        },
      );
    }

    if (outcome.outcome === "require_approval") {
      const policyName = outcome.decision.decisive?.policyName ?? "unknown";
      return {
        ...execution,
        result: {
          content:
            `The result of ${execution.toolName} requires approval under guardrail policy "${policyName}" ` +
            `and was withheld from the agent pending a human decision.`,
          data: {
            guardrail: {
              status: "require_approval",
              policyId: outcome.decision.decisive?.policyId ?? null,
              policyName,
              stage: "input",
              approvalId: null,
            },
          },
        },
      };
    }

    // `redact`: the matched span is replaced before the agent sees it.
    return {
      ...execution,
      result: {
        ...execution.result,
        content: outcome.content,
      },
    };
  }

  /**
   * The connector type behind a namespaced tool name, when the tool is a
   * connector tool. Uses the cached descriptor list so the lookup does not
   * re-initialise the connector dispatcher.
   */
  function connectorTypeFor(namespacedName: string): string | null {
    if (!connectorToolNames.has(namespacedName)) return null;
    const cached = connectorToolsCache.find((tool) => tool.name === namespacedName);
    if (cached) return cached.connectorType;
    refreshConnectorCache();
    return connectorToolsCache.find((tool) => tool.name === namespacedName)?.connectorType ?? null;
  }

  function toolCount(): { plugins: number; connectors: number; total: number } {
    const plugins = pluginDispatcher.toolCount();
    const connectors = connectorDispatcher.toolCount();
    return { plugins, connectors, total: plugins + connectors };
  }

  return { initialize, teardown, listToolsForAgent, getToolDescriptor, executeTool, toolCount };
}
