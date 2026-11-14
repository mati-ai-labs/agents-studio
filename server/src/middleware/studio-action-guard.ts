import type { Request, RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, heartbeatRuns, issueApprovals, issues } from "@paperclipai/db";
import { STUDIO_GUARDED_ACTIONS, type StudioGuardedAction } from "@paperclipai/shared";
import { guardrailService } from "../services/guardrails.js";
import { hashToolValue } from "../services/tool-content-guards.js";
import { logger } from "./logger.js";

/**
 * Studio action guard.
 *
 * Guardrail `action`-stage policies of kind `restricted_action` can name
 * studio actions (`paperclip:issue.create`, `paperclip:agent.update`, ...) in
 * `toolNames`. When an *agent* calls one of those API routes:
 *
 * - `block`            → 403, nothing happens.
 * - `require_approval` → the request is parked as a `guardrail_action`
 *                        approval and the agent gets 202 `pending_approval`.
 *                        When a board user approves, the server replays the
 *                        exact parked request as the agent (see
 *                        executeApprovedStudioAction); rejecting drops it.
 *
 * Board users are never gated, and with no matching policy every request
 * passes through unchanged.
 */

export const STUDIO_ACTION_APPROVAL_HEADER = "x-paperclip-approval-id";

type Route = { method: string; pattern: RegExp; action: (req: Request) => StudioGuardedAction | null };

const AGENT = "/agents/[^/]+";
const COMPANY = "/companies/[^/]+";

const ROUTES: Route[] = [
  {
    method: "POST",
    pattern: new RegExp(`^${COMPANY}/issues/?$`),
    action: (req) => (readString(req.body?.parentId) ? "paperclip:issue.create_subissue" : "paperclip:issue.create"),
  },
  { method: "POST", pattern: /^\/issues\/[^/]+\/children\/?$/, action: () => "paperclip:issue.create_subissue" },
  {
    method: "PATCH",
    pattern: /^\/issues\/[^/]+\/?$/,
    action: (req) =>
      req.body && (Object.hasOwn(req.body, "assigneeAgentId") || Object.hasOwn(req.body, "assigneeUserId"))
        ? "paperclip:issue.assign"
        : null,
  },
  { method: "POST", pattern: new RegExp(`^${COMPANY}/agents/?$`), action: () => "paperclip:agent.create" },
  { method: "POST", pattern: new RegExp(`^${COMPANY}/agent-hires/?$`), action: () => "paperclip:agent.create" },
  { method: "PATCH", pattern: new RegExp(`^${AGENT}/?$`), action: () => "paperclip:agent.update" },
  { method: "PATCH", pattern: new RegExp(`^${AGENT}/instructions-(path|bundle)/?$`), action: () => "paperclip:agent.update" },
  { method: "PUT", pattern: new RegExp(`^${AGENT}/instructions-bundle/file/?$`), action: () => "paperclip:agent.update" },
  { method: "DELETE", pattern: new RegExp(`^${AGENT}/instructions-bundle/file/?$`), action: () => "paperclip:agent.update" },
  { method: "POST", pattern: new RegExp(`^${AGENT}/config-revisions/[^/]+/rollback/?$`), action: () => "paperclip:agent.update" },
  { method: "PATCH", pattern: new RegExp(`^${AGENT}/permissions/?$`), action: () => "paperclip:agent.update_permissions" },
  { method: "POST", pattern: new RegExp(`^${AGENT}/(pause|resume|terminate)/?$`), action: () => "paperclip:agent.lifecycle" },
  { method: "DELETE", pattern: new RegExp(`^${AGENT}/?$`), action: () => "paperclip:agent.lifecycle" },
  { method: "POST", pattern: new RegExp(`^${AGENT}/keys/?$`), action: () => "paperclip:agent.create_key" },
  { method: "POST", pattern: new RegExp(`^${COMPANY}/routines/?$`), action: () => "paperclip:routine.create" },
];

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** The studio action an API request performs, or null when it is not a guarded action. */
export function classifyStudioAction(method: string, path: string, body: unknown): StudioGuardedAction | null {
  const upper = method.toUpperCase();
  const req = { body } as Request;
  for (const route of ROUTES) {
    if (route.method === upper && route.pattern.test(path)) return route.action(req);
  }
  return null;
}

export interface ParkedStudioRequest {
  method: string;
  path: string;
  body: unknown;
}

export function studioRequestHash(request: ParkedStudioRequest): string {
  return hashToolValue({ method: request.method.toUpperCase(), path: request.path, body: request.body ?? null });
}

function labelFor(action: StudioGuardedAction): string {
  return STUDIO_GUARDED_ACTIONS.find((entry) => entry.action === action)?.label ?? action;
}

function describeRequest(action: StudioGuardedAction, body: unknown): string {
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const title = readString(record.title) ?? readString(record.name);
  return title ? `${labelFor(action)}: ${title}` : labelFor(action);
}

export function studioActionGuard(db: Db): RequestHandler {
  const guardrails = guardrailService(db);

  return async (req, res, next) => {
    try {
      if (req.actor?.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
        next();
        return;
      }
      const action = classifyStudioAction(req.method, req.path, req.body);
      if (!action) {
        next();
        return;
      }
      const companyId = req.actor.companyId;
      const agentId = req.actor.agentId;
      const runId = req.actor.runId ?? null;
      const request: ParkedStudioRequest = { method: req.method.toUpperCase(), path: req.path, body: req.body ?? null };
      const argumentsHash = studioRequestHash(request);

      // The server replaying an approved request presents the approval id.
      const presentedApprovalId = readString(req.header(STUDIO_ACTION_APPROVAL_HEADER));
      if (presentedApprovalId) {
        const approval = await db
          .select()
          .from(approvals)
          .where(and(eq(approvals.id, presentedApprovalId), eq(approvals.companyId, companyId)))
          .then((rows) => rows[0] ?? null);
        const payload = (approval?.payload ?? {}) as Record<string, unknown>;
        if (
          approval &&
          approval.type === "guardrail_action" &&
          approval.status === "approved" &&
          payload.studioAction === true &&
          payload.agentId === agentId &&
          payload.argumentsHash === argumentsHash &&
          (await guardrails.consumeGuardrailApproval(approval.id))
        ) {
          next();
          return;
        }
        res.status(403).json({
          error: "The approval does not cover this request, or it was already used",
          code: "guardrail_approval_invalid",
          approvalId: presentedApprovalId,
        });
        return;
      }

      let parkedApprovalId: string | null = null;
      const outcome = await guardrails.enforceToolAction({
        companyId,
        toolName: action,
        parameters: request,
        agentId,
        runId,
        park: async (parked) => {
          const issueId = runId
            ? await db
                .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
                .from(heartbeatRuns)
                .where(eq(heartbeatRuns.id, runId))
                .then((rows) => {
                  const snapshot = (rows[0]?.contextSnapshot ?? {}) as Record<string, unknown>;
                  return readString(snapshot.issueId) ?? readString(snapshot.taskId);
                })
            : null;
          const agentName = await db
            .select({ name: agents.name })
            .from(agents)
            .where(eq(agents.id, agentId))
            .then((rows) => rows[0]?.name ?? "An agent");
          const [approval] = await db
            .insert(approvals)
            .values({
              companyId,
              type: "guardrail_action",
              requestedByAgentId: agentId,
              status: "pending",
              payload: {
                title: describeRequest(action, request.body),
                summary: `${agentName} wants to: ${labelFor(action)}. Guardrail policy "${parked.policyName}" requires your approval.`,
                recommendedAction: "Approve to carry out exactly this request as the agent; reject to drop it.",
                source: "guardrails",
                studioAction: true,
                tool: action,
                request,
                arguments: request.body,
                agentId,
                runId,
                issueId,
                policyId: parked.policyId,
                policyName: parked.policyName,
                stage: parked.stage,
                argumentsHash,
              },
            })
            .returning();
          parked.approvalId = approval?.id ?? null;
          parkedApprovalId = parked.approvalId;
          if (approval && issueId) {
            const issueExists = await db
              .select({ id: issues.id })
              .from(issues)
              .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
              .then((rows) => rows.length > 0);
            if (issueExists) {
              await db
                .insert(issueApprovals)
                .values({ companyId, issueId, approvalId: approval.id, linkedByAgentId: agentId })
                .onConflictDoNothing();
            }
          }
        },
      });

      const policyName = outcome.decision.decisive?.policyName ?? "unknown";
      if (outcome.outcome === "allow") {
        next();
        return;
      }
      if (outcome.outcome === "block") {
        res.status(403).json({
          error: `${labelFor(action)} is blocked for agents by guardrail policy "${policyName}"`,
          code: "guardrail_policy_blocked",
          action,
          policyId: outcome.decision.decisive?.policyId ?? null,
        });
        return;
      }
      if (outcome.outcome === "cancelled") {
        res.status(403).json({
          error: `The board rejected this request (${labelFor(action)}) under guardrail policy "${policyName}". Do not retry it.`,
          code: "guardrail_approval_rejected",
          action,
          approvalId: outcome.approvalId,
        });
        return;
      }
      res.status(202).json({
        status: "pending_approval",
        code: "guardrail_approval_required",
        action,
        approvalId: outcome.approvalId ?? parkedApprovalId,
        policyName,
        message:
          `${labelFor(action)} needs board approval under guardrail policy "${policyName}". ` +
          "Nothing was done yet. If the board approves, the server carries out exactly this request for you and you are woken with the result. " +
          "Do not retry or work around it; continue with other work or end the run.",
      });
    } catch (error) {
      // Fail closed: a guard that cannot decide must not let a gated action through.
      logger.error({ err: error, path: req.path }, "studio action guard failed");
      res.status(503).json({ error: "Guardrail check failed; try again later", code: "guardrail_unavailable" });
    }
  };
}
