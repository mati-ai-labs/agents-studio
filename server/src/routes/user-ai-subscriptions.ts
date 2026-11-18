import { Router, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, authUsers, issues } from "@paperclipai/db";
import { issueService, logActivity } from "../services/index.js";
import {
  assertProvider,
  providerForAdapterType,
  userAiSubscriptionService,
} from "../services/user-ai-subscriptions.js";
import { badRequest, conflict, forbidden } from "../errors.js";
import { assertBoard, getAccessibleResource, getActorInfo } from "./authz.js";

/**
 * Only a signed-in human (board actor) may manage subscriptions. Agents — even
 * agents acting on behalf of a user — are rejected by assertBoard.
 */
function requireBoardUserId(req: Request, res: Response): string | null {
  assertBoard(req);
  if (!req.actor.userId) {
    res.status(403).json({ error: "Board user context required" });
    return null;
  }
  return req.actor.userId;
}

function isInstanceAdmin(req: Request) {
  return req.actor.type === "board" && (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin === true);
}

export function userAiSubscriptionRoutes(db: Db) {
  const router = Router();
  const svc = userAiSubscriptionService(db);
  const issuesSvc = issueService(db);

  // ---- The signed-in user's own credentials. No route accepts a userId. ----

  router.get("/me/ai-subscriptions", async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    res.json({
      subscriptions: await svc.list(userId),
      codexDeviceLogin: svc.getCodexDeviceLoginState(userId),
    });
  });

  router.put("/me/ai-subscriptions/claude", async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    if (!token.trim()) throw badRequest("token is required");
    res.json(await svc.saveClaudeSetupToken(userId, token));
  });

  router.put("/me/ai-subscriptions/codex/auth-json", async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    const raw = typeof req.body?.authJson === "string" ? req.body.authJson : "";
    if (!raw.trim()) throw badRequest("authJson is required");
    res.json(await svc.saveCodexAuthJson(userId, raw));
  });

  router.post("/me/ai-subscriptions/codex/device-login", async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    res.json(await svc.startCodexDeviceLogin(userId));
  });

  router.get("/me/ai-subscriptions/codex/device-login", async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    res.json(svc.getCodexDeviceLoginState(userId));
  });

  router.delete("/me/ai-subscriptions/codex/device-login", async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    svc.cancelCodexDeviceLogin(userId);
    res.json(svc.getCodexDeviceLoginState(userId));
  });

  router.get("/me/ai-subscriptions/:provider/models", async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    const provider = assertProvider(req.params.provider);
    const models = await svc.listModels(userId, provider);
    if (!models) throw badRequest(`Connect your ${provider === "claude" ? "Claude" : "Codex"} subscription first.`);
    res.json(models);
  });

  router.delete("/me/ai-subscriptions/:provider", async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    const provider = assertProvider(req.params.provider);
    await svc.disconnect(userId, provider);
    res.json({ ok: true });
  });

  // ---- Per-issue selection ----

  async function describeIssue(req: Request, issue: { id: string; companyId: string; assigneeAgentId: string | null; subscriptionOwnerUserId?: string | null }) {
    const userId = req.actor.type === "board" ? req.actor.userId ?? null : null;
    const assignee = issue.assigneeAgentId
      ? await db
          .select({ adapterType: agents.adapterType })
          .from(agents)
          .where(and(eq(agents.id, issue.assigneeAgentId), eq(agents.companyId, issue.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const provider = providerForAdapterType(assignee?.adapterType);
    const ownerUserId = issue.subscriptionOwnerUserId ?? null;
    const owner = ownerUserId
      ? await db
          .select({ name: authUsers.name })
          .from(authUsers)
          .where(eq(authUsers.id, ownerUserId))
          .then((rows) => rows[0] ?? null)
      : null;
    const mine = userId && provider ? await svc.get(userId, provider) : null;
    return {
      issueId: issue.id,
      provider,
      ownerUserId,
      ownerName: owner?.name ?? null,
      isMine: Boolean(userId && ownerUserId === userId),
      canClear: Boolean(ownerUserId && (ownerUserId === userId || isInstanceAdmin(req))),
      mySubscription: mine,
    };
  }

  router.get("/issues/:id/ai-subscription", async (req, res) => {
    const issue = await getAccessibleResource(req, res, issuesSvc.getById(req.params.id as string), "Issue not found");
    if (!issue) return;
    res.json(await describeIssue(req, issue));
  });

  // Model names on the issue owner's subscription (the credential itself never leaves the server).
  router.get("/issues/:id/ai-subscription/models", async (req, res) => {
    const issue = await getAccessibleResource(req, res, issuesSvc.getById(req.params.id as string), "Issue not found");
    if (!issue) return;
    const info = await describeIssue(req, issue);
    if (!info.ownerUserId || !info.provider) {
      res.json([]);
      return;
    }
    res.json((await svc.listModels(info.ownerUserId, info.provider)) ?? []);
  });

  router.put("/issues/:id/ai-subscription", async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    const issue = await getAccessibleResource(req, res, issuesSvc.getById(req.params.id as string), "Issue not found");
    if (!issue) return;
    const enabled = req.body?.enabled;
    if (typeof enabled !== "boolean") throw badRequest("enabled must be a boolean");
    const currentOwner = (issue as { subscriptionOwnerUserId?: string | null }).subscriptionOwnerUserId ?? null;

    if (enabled) {
      // You can only ever attach YOUR OWN subscription.
      if (currentOwner && currentOwner !== userId) {
        throw conflict("Another user's subscription is attached to this issue. They (or an instance admin) must switch it back to Studio default first.");
      }
      const info = await describeIssue(req, issue);
      if (!info.provider) {
        throw badRequest("This issue's assignee doesn't run on Claude Code or Codex, so a personal subscription can't be used.");
      }
      if (!info.mySubscription || info.mySubscription.status !== "active") {
        throw badRequest(`Connect your ${info.provider === "claude" ? "Claude" : "Codex"} subscription first (Settings → My AI subscriptions).`);
      }
    } else if (currentOwner && currentOwner !== userId && !isInstanceAdmin(req)) {
      throw forbidden("Only the user whose subscription is attached (or an instance admin) can switch this issue back.");
    }

    const nextOwner = enabled ? userId : null;
    await db
      .update(issues)
      .set({ subscriptionOwnerUserId: nextOwner, updatedAt: new Date() })
      .where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId)));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: enabled ? "issue.ai_subscription_attached" : "issue.ai_subscription_detached",
      entityType: "issue",
      entityId: issue.id,
      details: { previousOwnerUserId: currentOwner, ownerUserId: nextOwner },
    });
    res.json(await describeIssue(req, { ...issue, subscriptionOwnerUserId: nextOwner }));
  });

  return router;
}

/**
 * "Run with: My subscription" chosen in the new-issue dialog. The owner is always
 * the acting board user — never a user id from the request body.
 */
export async function resolveSubscriptionOwnerForNewIssue(
  db: Db,
  req: Request,
  companyId: string,
  assigneeAgentId: string | null | undefined,
): Promise<string> {
  if (req.actor.type !== "board" || !req.actor.userId) {
    throw forbidden("Only a signed-in user can attach their own subscription");
  }
  const userId = req.actor.userId;
  const assignee = assigneeAgentId
    ? await db
        .select({ adapterType: agents.adapterType })
        .from(agents)
        .where(and(eq(agents.id, assigneeAgentId), eq(agents.companyId, companyId)))
        .then((rows) => rows[0] ?? null)
    : null;
  const provider = providerForAdapterType(assignee?.adapterType);
  if (!provider) {
    throw badRequest("A personal subscription needs the issue to be assigned to a Claude Code or Codex agent.");
  }
  const mine = await userAiSubscriptionService(db).get(userId, provider);
  if (!mine || mine.status !== "active") {
    throw badRequest(`Connect your ${provider === "claude" ? "Claude" : "Codex"} subscription first (Settings → AI subscriptions).`);
  }
  return userId;
}
