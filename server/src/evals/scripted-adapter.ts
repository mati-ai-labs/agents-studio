import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import type { EvalAgentAction } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import { issueService } from "../services/issues.js";

export const EVAL_SCRIPTED_ADAPTER_TYPE = "eval_scripted";

/**
 * What the scripted agent reports back to the harness after a run.
 */
export interface ScriptedAgentOutcome {
  /** Actions that were attempted, with their outcome. */
  actions: Array<{
    action: EvalAgentAction["type"];
    ok: boolean;
    status?: number;
    error?: string;
  }>;
  /** Policy ids that the tool access engine reported as matching. */
  firedPolicyIds: string[];
}

export interface ScriptedAdapterOptions {
  /** The actions the scripted agent performs, in order. */
  script: EvalAgentAction[];
  /** Issue the agent acts on. */
  issueId: string;
  /** Company the scenario was seeded into. */
  companyId: string;
}

/**
 * A deterministic stand-in for a model.
 *
 * The point is not to simulate intelligence: it is to drive the *real* control
 * plane (tool access policy, comment creation, issue lifecycle) with a
 * reproducible sequence of actions, so the deterministic checks can run without
 * provider credentials while still exercising production code paths.
 */
export function createScriptedAdapter(
  db: Db,
  options: ScriptedAdapterOptions,
): ServerAdapterModule {
  const outcome: ScriptedAgentOutcome = { actions: [], firedPolicyIds: [] };
  const policy = toolAccessPolicyService(db);
  const issues = issueService(db);

  const adapter: ServerAdapterModule = {
    type: EVAL_SCRIPTED_ADAPTER_TYPE,
    supportsLocalAgentJwt: false,

    execute: async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
      const runId = ctx.runId;
      const agentId = ctx.agent.id;

      for (const action of options.script) {
        try {
          switch (action.type) {
            case "noop":
              outcome.actions.push({ action: "noop", ok: true });
              break;

            case "comment": {
              const comment = await issues.addComment(
                options.issueId,
                action.body,
                { agentId, runId },
                { authorType: "agent" },
              );
              outcome.actions.push({
                action: "comment",
                ok: Boolean(comment),
                ...(comment ? {} : { error: "comment was not created" }),
              });
              break;
            }

            case "checkout_issue": {
              await issues.checkout(
                options.issueId,
                agentId,
                ["todo", "backlog", "blocked", "in_progress"],
                runId,
              );
              outcome.actions.push({ action: "checkout_issue", ok: true });
              break;
            }

            case "set_issue_status": {
              const updated = await issues.update(
                options.issueId,
                { status: action.status, actorAgentId: agentId },
              );
              outcome.actions.push({
                action: "set_issue_status",
                ok: Boolean(updated),
                ...(updated ? {} : { error: `issue status was not set to "${action.status}"` }),
              });
              break;
            }

            case "call_tool": {
              const result = await callTool({
                db,
                policy,
                companyId: options.companyId,
                agentId,
                runId,
                issueId: options.issueId,
                tool: action.tool,
                parameters: action.parameters ?? {},
              });
              outcome.firedPolicyIds.push(...result.matchedPolicyIds);
              outcome.actions.push({
                action: "call_tool",
                ok: result.ok,
                status: result.status,
                ...(result.error ? { error: result.error } : {}),
              });
              break;
            }

            default: {
              const exhaustive = action as { type: string };
              outcome.actions.push({
                action: exhaustive.type as EvalAgentAction["type"],
                ok: false,
                error: `unsupported action "${exhaustive.type}"`,
              });
            }
          }
        } catch (error) {
          outcome.actions.push({
            action: action.type,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const lastComment = [...outcome.actions].reverse().find((entry) => entry.action === "comment");

      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        provider: "eval",
        model: readConfiguredModel(ctx.config),
        // A non-zero cost makes the run observable in `cost_events`, which is
        // where the cohort metric reads its efficiency numbers from.
        usage: { inputTokens: 120, outputTokens: 40, cachedInputTokens: 0 },
        costUsd: 0.01,
        resultJson: {
          scripted: true,
          actions: outcome.actions,
          firedPolicyIds: [...new Set(outcome.firedPolicyIds)],
        },
        summary: lastComment?.ok ? "scripted agent completed" : "scripted agent ran",
      };
    },

    testEnvironment: async () => ({
      adapterType: EVAL_SCRIPTED_ADAPTER_TYPE,
      status: "pass",
      checks: [],
      testedAt: new Date().toISOString(),
    }),

    models: [{ id: "eval-scripted", label: "Eval Scripted Model" }],
  };

  return adapter;
}

interface ToolCallOutcome {
  ok: boolean;
  status: number;
  error?: string;
  /** Policy ids the engine reported as matching this call. */
  matchedPolicyIds: string[];
}

/**
 * Read the model out of the resolved adapter config.
 *
 * The config is untyped JSON, so the model is only used when it really is a
 * string; otherwise the run is attributed to the scripted model.
 */
function readConfiguredModel(config: Record<string, unknown>): string {
  const model = config.model;
  return typeof model === "string" && model.trim() !== "" ? model : "eval-scripted";
}

/**
 * Run one tool call through the real tool access policy engine.
 *
 * The policy engine is the thing under test for the restricted-action
 * scenarios, so the call is routed through `decide` + `recordInvocation`
 * rather than through a stubbed decision. The invocation row it writes is what
 * the scorer later reads back out of `tool_call_events`.
 */
async function callTool(input: {
  db: Db;
  policy: ReturnType<typeof toolAccessPolicyService>;
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string;
  tool: string;
  parameters: Record<string, unknown>;
}): Promise<ToolCallOutcome> {
  const { policy } = input;
  const toolName = input.tool;

  const decisionInput = {
    companyId: input.companyId,
    actor: {
      actorType: "agent" as const,
      actorId: input.agentId,
      agentId: input.agentId,
    },
    runContext: {
      heartbeatRunId: input.runId,
      issueId: input.issueId,
      projectId: null,
      gatewayId: null,
    },
    request: {
      toolName,
      providerType: "mcp_http_fixture",
      upstreamToolName: toolName,
      riskLevel: toolName.endsWith("update_note") ? ("write" as const) : ("read" as const),
      arguments: input.parameters,
      idempotencyKey: null,
      sideEffecting: toolName.endsWith("update_note"),
    },
    consumeRateLimit: false,
  };

  const decision = await policy.decide(decisionInput);
  const recorded = await policy.recordInvocation(decisionInput, decision);
  await policy.writeAudit(decisionInput, decision);

  if (!decision.allowed) {
    return {
      ok: false,
      status: decision.decision === "require_approval" ? 202 : 403,
      error: decision.explanation,
      matchedPolicyIds: decision.matchedPolicyIds,
    };
  }

  return { ok: true, status: 200, matchedPolicyIds: decision.matchedPolicyIds };
}

/**
 * The adapter reports its outcome through `resultJson`, so the harness reads
 * the fired policy ids from there rather than from a side channel.
 */
export function readScriptedOutcome(resultJson: unknown): ScriptedAgentOutcome {
  if (typeof resultJson !== "object" || resultJson === null) {
    return { actions: [], firedPolicyIds: [] };
  }
  const value = resultJson as Record<string, unknown>;
  return {
    actions: Array.isArray(value.actions) ? (value.actions as ScriptedAgentOutcome["actions"]) : [],
    firedPolicyIds: Array.isArray(value.firedPolicyIds)
      ? (value.firedPolicyIds as string[])
      : [],
  };
}
