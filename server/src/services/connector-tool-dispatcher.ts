/**
 * ConnectorToolDispatcher — bridges connector tools into the agent tool system.
 *
 * Integrates with the PluginToolDispatcher so connector tools (Google Workspace,
 * Notion, Linear) appear in the same `listTools` / `executeTool` flow used by
 * plugin tools. When a connector is connected, its tools are registered and
 * become available to agents through the unified tool dispatching mechanism.
 *
 * This service is created at server startup and is composed together with
 * PluginToolDispatcher into a UnifiedToolDispatcher that agents actually call.
 *
 * @see connector-registry.ts
 * @see connector-tools.ts
 */
import type { Db } from "@paperclipai/db";
import type { ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import {
  executeConnectorTool,
  CONNECTOR_TOOLS,
} from "./connector-tools.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * An agent-facing connector tool descriptor.
 */
export interface ConnectorToolDescriptor {
  name: string;
  displayName: string;
  description: string;
  parametersSchema: Record<string, unknown>;
  connectorType: string;
}

/**
 * Result of a connector tool execution with routing metadata.
 */
export interface ConnectorToolExecutionResult {
  connectorType: string;
  toolName: string;
  result: ToolResult;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateConnectorToolDispatcherOptions {
  db: Db;
}

export function createConnectorToolDispatcher(
  options: CreateConnectorToolDispatcherOptions,
): ConnectorToolDispatcher {
  const { db } = options;

  /** Map: namespacedName → ConnectorToolDescriptor */
  const byNamespace = new Map<string, ConnectorToolDescriptor>();
  /** Map: connectorType → Set<namespacedName> */
  const byConnectorType = new Map<string, Set<string>>();

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function capitalizeWords(str: string): string {
    return str.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function buildToolDescriptors(connectorType: string): ConnectorToolDescriptor[] {
    const tools = CONNECTOR_TOOLS[connectorType as keyof typeof CONNECTOR_TOOLS];
    if (!tools) return [];
    return tools.map((tool) => ({
      name: `${connectorType}:${tool.name}`,
      displayName: `${capitalizeWords(connectorType)} ${capitalizeWords(tool.name)}`,
      description: tool.description,
      parametersSchema: tool.inputSchema,
      connectorType,
    }));
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /**
   * Register all tools for a given connector type.
   * Idempotent — replaces any previously registered tools for this type.
   */
  function registerToolsForConnectorType(connectorType: string): void {
    const previous = byConnectorType.get(connectorType);
    if (previous) {
      for (const name of previous) byNamespace.delete(name);
    }

    const descriptors = buildToolDescriptors(connectorType);
    if (descriptors.length === 0) return;

    const set = new Set<string>();
    for (const d of descriptors) {
      byNamespace.set(d.name, d);
      set.add(d.name);
    }
    byConnectorType.set(connectorType, set);

    logger.debug({ connectorType, count: descriptors.length }, "Registered connector tools");
  }

  /**
   * Unregister all tools for a given connector type.
   */
  function unregisterToolsForConnectorType(connectorType: string): void {
    const previous = byConnectorType.get(connectorType);
    if (previous) {
      for (const name of previous) byNamespace.delete(name);
      byConnectorType.delete(connectorType);
      logger.debug({ connectorType }, "Unregistered connector tools");
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async function initialize(): Promise<void> {
    for (const type of CONNECTOR_TYPES) {
      registerToolsForConnectorType(type);
    }
    logger.info({ totalTools: byNamespace.size }, "Connector tool dispatcher initialized");
  }

  /** Refresh tools (re-register all connector types). */
  async function refresh(): Promise<void> {
    for (const type of CONNECTOR_TYPES) {
      registerToolsForConnectorType(type);
    }
  }

  /** All registered connector tool descriptors. */
  function listTools(): ConnectorToolDescriptor[] {
    return Array.from(byNamespace.values());
  }

  /** Look up a tool by namespaced name. */
  function getTool(namespacedName: string): ConnectorToolDescriptor | null {
    return byNamespace.get(namespacedName) ?? null;
  }

  /**
   * Check if a namespaced name refers to a connector tool.
   */
  function isConnectorTool(namespacedName: string): boolean {
    return byNamespace.has(namespacedName);
  }

  /**
   * Execute a connector tool.
   * Returns ToolExecutionResult with routing metadata.
   */
  async function executeTool(
    namespacedName: string,
    parameters: unknown,
    companyId: string,
  ): Promise<ConnectorToolExecutionResult> {
    const tool = byNamespace.get(namespacedName);
    if (!tool) {
      throw new Error(`Connector tool not found: ${namespacedName}`);
    }

    const colonIdx = namespacedName.indexOf(":");
    const bareName = colonIdx >= 0 ? namespacedName.slice(colonIdx + 1) : namespacedName;

    logger.debug(
      { tool: namespacedName, companyId, bareName },
      "Executing connector tool",
    );

    const result = await executeConnectorTool(
      db,
      bareName,
      companyId,
      parameters as Record<string, unknown>,
    );

    const toolResult: ToolResult = result.success
      ? {
          content: JSON.stringify(result.data ?? result),
          data: result.data,
        }
      : {
          error: result.error ?? "Unknown error",
        };

    return { connectorType: tool.connectorType, toolName: bareName, result: toolResult };
  }

  function toolCount(): number {
    return byNamespace.size;
  }

  return {
    initialize,
    refresh,
    listTools,
    getTool,
    isConnectorTool,
    executeTool,
    toolCount,
  };
}

// ---------------------------------------------------------------------------
// Public interface (for composition with PluginToolDispatcher)
// ---------------------------------------------------------------------------

export interface ConnectorToolDispatcher {
  initialize(): Promise<void>;
  refresh(): Promise<void>;
  listTools(): ConnectorToolDescriptor[];
  getTool(namespacedName: string): ConnectorToolDescriptor | null;
  isConnectorTool(namespacedName: string): boolean;
  executeTool(
    namespacedName: string,
    parameters: unknown,
    companyId: string,
  ): Promise<ConnectorToolExecutionResult>;
  toolCount(): number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONNECTOR_TYPES = ["google_workspace", "notion", "linear"] as const;
