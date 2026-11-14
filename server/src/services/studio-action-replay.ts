import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, issues } from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { STUDIO_ACTION_APPROVAL_HEADER } from "../middleware/studio-action-guard.js";
import { issueService } from "./issues.js";
import { logger } from "../middleware/logger.js";

/**
 * Carries out a studio action an agent requested and a board user approved.
 *
 * The parked request (method, path, body) is replayed against this server
 * over loopback, authenticated as the requesting agent and presenting the
 * approval id. The studio action guard accepts it only for that exact request
 * and spends the approval, so one approval performs the action exactly once
 * and goes through the same route logic as if the agent had made it.
 *
 * The outcome is written back onto the approval payload and posted as a
 * comment on the linked issue, so the agent (woken by the approval) and the
 * board both see what happened.
 */
export interface StudioActionReplayResult {
  executed: boolean;
  status: number | null;
  error: string | null;
  responseBody: unknown;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function describeCreated(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const identifier = readString(record.identifier);
  const name = readString(record.name) ?? readString(record.title);
  if (identifier && name) return `${identifier} "${name}"`;
  return identifier ?? name;
}

export async function executeApprovedStudioAction(
  db: Db,
  approvalId: string,
  options: { port: number; fetchImpl?: typeof fetch },
): Promise<StudioActionReplayResult | null> {
  const approval = await db.select().from(approvals).where(eq(approvals.id, approvalId)).then((rows) => rows[0] ?? null);
  if (!approval || approval.type !== "guardrail_action" || approval.status !== "approved") return null;
  const payload = (approval.payload ?? {}) as Record<string, unknown>;
  if (payload.agentAction === true) {
    // An action the agent's own guardrail hook held: the agent re-runs it.
    const issueId = readString(payload.issueId);
    if (issueId) {
      await issueService(db)
        .addComment(
          issueId,
          (() => {
            const args = (payload.arguments ?? {}) as Record<string, unknown>;
            const command = readString(args.command);
            const what = readString(payload.title) ?? readString(payload.tool) ?? "agent action";
            return command
              ? `Board approved: ${what}. Run exactly this command again; it will be allowed once (any credential shown as ***REDACTED*** is your usual one, e.g. $PAPERCLIP_API_KEY):\n\n\`\`\`\n${command}\n\`\`\``
              : `Board approved: ${what}. Run exactly the same ${readString(payload.tool) ?? "tool"} action again; it will be allowed once.`;
          })(),
          {},
          { authorType: "system" },
        )
        .catch((error) => logger.warn({ err: error, approvalId }, "failed to post approval comment"));
    }
    return null;
  }
  if (payload.studioAction !== true) return null;

  const request = (payload.request ?? {}) as Record<string, unknown>;
  const method = readString(request.method);
  const path = readString(request.path);
  const agentId = readString(payload.agentId);
  if (!method || !path || !agentId) return null;

  let result: StudioActionReplayResult;
  const agent = await db
    .select({ id: agents.id, adapterType: agents.adapterType, status: agents.status })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, approval.companyId)))
    .then((rows) => rows[0] ?? null);
  const runId = readString(payload.runId) ?? `approval-${approval.id}`;
  const token = agent ? createLocalAgentJwt(agent.id, approval.companyId, agent.adapterType, runId) : null;

  if (!agent) {
    result = { executed: false, status: null, error: "The requesting agent no longer exists", responseBody: null };
  } else if (!token) {
    result = {
      executed: false,
      status: null,
      error: "Agent JWT signing is not configured on this server (PAPERCLIP_AGENT_JWT_SECRET), so the approved request could not be replayed",
      responseBody: null,
    };
  } else {
    try {
      const response = await (options.fetchImpl ?? fetch)(`http://127.0.0.1:${options.port}/api${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          [STUDIO_ACTION_APPROVAL_HEADER]: approval.id,
          ...(readString(payload.runId) ? { "x-paperclip-run-id": readString(payload.runId)! } : {}),
        },
        body: method === "GET" || (method === "DELETE" && request.body == null) ? undefined : JSON.stringify(request.body ?? {}),
      });
      const text = await response.text();
      let responseBody: unknown = text;
      try {
        responseBody = text ? JSON.parse(text) : null;
      } catch {
        // keep raw text
      }
      result = {
        executed: response.ok,
        status: response.status,
        error: response.ok ? null : readString((responseBody as Record<string, unknown> | null)?.error) ?? `HTTP ${response.status}`,
        responseBody,
      };
    } catch (error) {
      result = { executed: false, status: null, error: error instanceof Error ? error.message : String(error), responseBody: null };
    }
  }

  const executedAt = new Date().toISOString();
  await db
    .update(approvals)
    .set({
      payload: sql`${approvals.payload} || ${JSON.stringify({
        executedAt,
        execution: {
          executed: result.executed,
          status: result.status,
          error: result.error,
          created: describeCreated(result.responseBody),
        },
      })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(approvals.id, approval.id));

  const issueId = readString(payload.issueId);
  if (issueId) {
    const issue = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, approval.companyId)))
      .then((rows) => rows[0] ?? null);
    if (issue) {
      const title = readString(payload.title) ?? readString(payload.tool) ?? "agent action";
      const created = describeCreated(result.responseBody);
      const body = result.executed
        ? `Board approved and the studio carried out: ${title}${created ? ` → ${created}` : ""}.`
        : `Board approved "${title}", but carrying it out failed: ${result.error ?? "unknown error"}.`;
      try {
        await issueService(db).addComment(issue.id, body, {}, { authorType: "system" });
      } catch (error) {
        logger.warn({ err: error, approvalId: approval.id }, "failed to post studio action outcome comment");
      }
    }
  }

  if (!result.executed) {
    logger.warn({ approvalId: approval.id, status: result.status, error: result.error }, "approved studio action did not execute");
  }
  return result;
}

/** Posts the rejection on the linked issue so the requesting agent sees it on its next wake. */
export async function noteRejectedStudioAction(db: Db, approvalId: string, decisionNote?: string | null) {
  const approval = await db.select().from(approvals).where(eq(approvals.id, approvalId)).then((rows) => rows[0] ?? null);
  if (!approval || approval.type !== "guardrail_action") return;
  const payload = (approval.payload ?? {}) as Record<string, unknown>;
  if (payload.studioAction !== true && payload.agentAction !== true) return;
  const issueId = readString(payload.issueId);
  if (!issueId) return;
  const title = readString(payload.title) ?? readString(payload.tool) ?? "agent action";
  try {
    await issueService(db).addComment(
      issueId,
      `Board rejected: ${title}. It was not carried out; do not retry it.${decisionNote ? `\n\nNote: ${decisionNote}` : ""}`,
      {},
      { authorType: "system" },
    );
  } catch (error) {
    logger.warn({ err: error, approvalId }, "failed to post studio action rejection comment");
  }
}
