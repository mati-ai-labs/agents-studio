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
  const { pluginDispatcher, connectorDispatcher } = options;
  const log = logger.child({ service: "unified-tool-dispatcher" });

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
    // Try connector tools first (they use companyId from args)
    if (connectorToolNames.has(namespacedName)) {
      const companyId = runContext.companyId ?? (parameters as Record<string, unknown>).companyId as string | undefined;
      if (!companyId) {
        throw new Error(`companyId required to execute connector tool: ${namespacedName}`);
      }
      const result = await connectorDispatcher.executeTool(
        namespacedName,
        parameters,
        companyId,
      );
      return {
        source: "connector",
        toolName: result.toolName,
        ownerId: result.connectorType,
        result: result.result,
      };
    }

    // Fall through to plugin tools
    const pluginResult = await pluginDispatcher.executeTool(
      namespacedName,
      parameters,
      runContext,
    );
    return {
      source: "plugin",
      toolName: pluginResult.toolName,
      ownerId: pluginResult.pluginId,
      result: pluginResult.result,
    };
  }

  function toolCount(): { plugins: number; connectors: number; total: number } {
    const plugins = pluginDispatcher.toolCount();
    const connectors = connectorDispatcher.toolCount();
    return { plugins, connectors, total: plugins + connectors };
  }

  return { initialize, teardown, listToolsForAgent, getToolDescriptor, executeTool, toolCount };
}
