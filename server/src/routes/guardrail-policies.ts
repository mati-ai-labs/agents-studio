import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import {
  createGuardrailPolicySchema,
  guardrailViolationsQuerySchema,
  simulateGuardrailPoliciesSchema,
  updateGuardrailPolicySchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { accessService } from "../services/access.js";
import { guardrailService, type EffectivePolicy } from "../services/guardrails.js";
import { logActivity } from "../services/activity-log.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { forbidden, unprocessable } from "../errors.js";

export function guardrailPolicyRoutes(db: Db) {
  const router = Router();
  const guardrails = guardrailService(db);
  const access = accessService(db);

  /**
   * Authoring a policy is a privileged action: enabling `block` or
   * `require_approval` changes what every agent in the company may do, so it
   * needs the same authority as permission management.
   */
  async function assertCanAdministerPolicies(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      if (await access.canUser(companyId, req.actor.userId, "users:manage_permissions")) return;
    } else if (
      req.actor.type === "agent" &&
      req.actor.agentId &&
      (await access.hasPermission(companyId, "agent", req.actor.agentId, "users:manage_permissions"))
    ) {
      return;
    }
    throw forbidden("Guardrail policy administration authority required", {
      code: "guardrail_policy_admin_required",
      remediation: "Ask a company administrator to manage guardrail policies.",
    });
  }

  router.get("/companies/:companyId/guardrail-policies", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await guardrails.listPolicies(companyId));
  });

  router.get("/companies/:companyId/guardrail-policies/:policyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const policyId = req.params.policyId as string;
    assertCompanyAccess(req, companyId);
    const policy = await guardrails.getPolicy(companyId, policyId);
    if (!policy) {
      res.status(404).json({ error: "Guardrail policy not found" });
      return;
    }
    res.json(policy);
  });

  router.post(
    "/companies/:companyId/guardrail-policies",
    validate(createGuardrailPolicySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanAdministerPolicies(req, companyId);
      const actor = getActorInfo(req);
      const body = req.body;
      const created = await guardrails.createPolicy(companyId, {
        scopeType: body.scopeType,
        scopeId: body.scopeType === "company" ? null : body.scopeId!,
        stage: body.stage,
        name: body.name,
        description: body.description ?? null,
        kind: body.kind,
        matcher: body.matcher as Record<string, unknown>,
        action: body.action,
        severity: body.severity,
        enabled: body.enabled ?? true,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "guardrail_policy.created",
        entityType: "guardrail_policy",
        entityId: created.id,
        details: { name: created.name, kind: created.kind, stage: created.stage, action: created.action },
      });

      res.status(201).json(created);
    },
  );

  router.patch(
    "/companies/:companyId/guardrail-policies/:policyId",
    validate(updateGuardrailPolicySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const policyId = req.params.policyId as string;
      await assertCanAdministerPolicies(req, companyId);

      const existing = await guardrails.getPolicy(companyId, policyId);
      if (!existing) {
        res.status(404).json({ error: "Guardrail policy not found" });
        return;
      }

      const body = req.body;
      const nextKind = body.kind ?? existing.kind;
      const nextMatcher = body.matcher === undefined ? existing.matcher : body.matcher;
      const nextScopeType = body.scopeType ?? existing.scopeType;
      const nextScopeId = body.scopeId === undefined ? existing.scopeId : body.scopeId;

      // The matcher must stay consistent with the policy kind and the scope
      // must keep its shape, or the policy could not be evaluated later.
      if (body.kind && body.matcher === undefined) {
        throw unprocessable("matcher is required when the policy kind changes", {
          code: "guardrail_matcher_required",
        });
      }
      if (nextScopeType === "company" && nextScopeId) {
        throw unprocessable("scopeId must be omitted for company-scoped policies", {
          code: "guardrail_scope_id_invalid",
        });
      }
      if (nextScopeType !== "company" && !nextScopeId) {
        throw unprocessable("scopeId is required for agent, project and goal-scoped policies", {
          code: "guardrail_scope_id_required",
        });
      }

      const updated = await guardrails.updatePolicy(companyId, policyId, {
        ...(body.scopeType !== undefined ? { scopeType: body.scopeType } : {}),
        ...(body.scopeId !== undefined ? { scopeId: body.scopeType === "company" ? null : body.scopeId } : {}),
        ...(body.stage !== undefined ? { stage: body.stage } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description ?? null } : {}),
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        ...(body.matcher !== undefined ? { matcher: body.matcher as Record<string, unknown> } : {}),
        ...(body.action !== undefined ? { action: body.action } : {}),
        ...(body.severity !== undefined ? { severity: body.severity } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        version: existing.version + 1,
      });
      if (!updated) {
        res.status(404).json({ error: "Guardrail policy not found" });
        return;
      }

      await logActivity(db, {
        companyId,
        actorType: getActorInfo(req).actorType,
        actorId: getActorInfo(req).actorId,
        agentId: getActorInfo(req).agentId,
        action: "guardrail_policy.updated",
        entityType: "guardrail_policy",
        entityId: updated.id,
        details: { name: updated.name, kind: nextKind, version: updated.version },
      });

      res.json(updated);
    },
  );

  router.delete("/companies/:companyId/guardrail-policies/:policyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const policyId = req.params.policyId as string;
    await assertCanAdministerPolicies(req, companyId);
    const deleted = await guardrails.deletePolicy(companyId, policyId);
    if (!deleted) {
      res.status(404).json({ error: "Guardrail policy not found" });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: getActorInfo(req).actorType,
      actorId: getActorInfo(req).actorId,
      agentId: getActorInfo(req).agentId,
      action: "guardrail_policy.deleted",
      entityType: "guardrail_policy",
      entityId: deleted.id,
      details: { name: deleted.name, kind: deleted.kind },
    });
    res.json(deleted);
  });

  router.get("/companies/:companyId/guardrail-violations", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = guardrailViolationsQuerySchema.parse(req.query);
    const rows = await guardrails.listViolations(companyId, {
      policyId: query.policyId,
      stage: query.stage,
      agentId: query.agentId,
      runId: query.runId,
      action: query.action,
      resolved: query.resolved === undefined ? undefined : query.resolved === "true",
      since: query.since ? new Date(query.since) : undefined,
      until: query.until ? new Date(query.until) : undefined,
      limit: query.limit,
      offset: query.offset,
    });
    res.json(rows);
  });

  router.post("/companies/:companyId/guardrail-violations/:violationId/resolve", async (req, res) => {
    const companyId = req.params.companyId as string;
    const violationId = req.params.violationId as string;
    await assertCanAdministerPolicies(req, companyId);
    const resolved = await guardrails.resolveViolation(companyId, violationId);
    if (!resolved) {
      res.status(404).json({ error: "Guardrail violation not found" });
      return;
    }
    res.json(resolved);
  });

  /**
   * Simulates policies against a sample subject so a policy author can see
   * what a policy would do before saving it.
   */
  router.post(
    "/companies/:companyId/guardrail-policies/simulate",
    validate(simulateGuardrailPoliciesSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const body = req.body;

      // The candidate policy under test is evaluated alongside the stored
      // ones, so the author sees the combined effect.
      const policies: EffectivePolicy[] = [];
      if (body.candidatePolicy) {
        policies.push({
          policy: {
            id: "00000000-0000-0000-0000-000000000000",
            companyId,
            scopeType: body.candidatePolicy.scopeType,
            scopeId: body.candidatePolicy.scopeType === "company" ? null : body.candidatePolicy.scopeId ?? null,
            stage: body.candidatePolicy.stage,
            name: body.candidatePolicy.name,
            description: body.candidatePolicy.description ?? null,
            kind: body.candidatePolicy.kind,
            matcher: (body.candidatePolicy.matcher ?? {}) as Record<string, unknown>,
            action: body.candidatePolicy.action,
            severity: body.candidatePolicy.severity,
            enabled: body.candidatePolicy.enabled ?? true,
            version: 0,
          },
        });
      }
      if (body.policyIds && body.policyIds.length > 0) {
        const stored = await guardrails.listPolicies(companyId);
        for (const policy of stored) {
          if (!body.policyIds.includes(policy.id)) continue;
          policies.push({ policy });
        }
      }

      const subjectText = body.subject ?? "";
      const decision = await guardrails.applyGuardrails(
        {
          companyId,
          agentId: body.agentId ?? null,
          projectId: body.projectId ?? null,
          goalId: body.goalId ?? null,
          text: subjectText,
          fields: body.subjectFields ?? null,
          toolName: body.toolName ?? null,
          connectorType: body.connectorType ?? null,
          toolArguments: body.toolArguments ?? null,
        },
        {
          stage: body.stage,
          policies: policies.length > 0 ? policies : undefined,
        },
      );

      res.json({
        action: decision.action,
        decisive: decision.decisive,
        matches: decision.matches,
        redactedText: decision.action === "redact" ? decision.redactedText : null,
      });
    },
  );

  return router;
}
