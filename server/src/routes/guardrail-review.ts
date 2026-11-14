import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { guardrailActionReviewService } from "../services/guardrail-action-review.js";

const reviewActionSchema = z.object({
  toolName: z.string().trim().min(1).max(200),
  toolInput: z.unknown().optional(),
});

/**
 * Endpoints the agent-side guardrail hook calls (see the claude_local
 * adapter's guardrail hook). Agent auth only: the agent and run come from the
 * agent's own token, never from the request body.
 */
export function guardrailReviewRoutes(db: Db): Router {
  const router = Router();
  const review = guardrailActionReviewService(db);

  router.get("/guardrails/agent-context", async (req, res, next) => {
    try {
      if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) throw forbidden("Agent authentication required");
      const context = await review.agentRulesContext(req.actor.companyId, req.actor.agentId);
      res.json({ context });
    } catch (error) {
      next(error);
    }
  });

  router.post("/guardrails/review-action", async (req, res, next) => {
    try {
      if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) throw forbidden("Agent authentication required");
      const input = reviewActionSchema.parse(req.body ?? {});
      const result = await review.reviewAction({
        companyId: req.actor.companyId,
        agentId: req.actor.agentId,
        runId: req.actor.runId ?? null,
        toolName: input.toolName,
        toolInput: input.toolInput ?? null,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
