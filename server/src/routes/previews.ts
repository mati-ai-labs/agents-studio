import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createPreviewLeaseSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { pinRuntimeServiceForPreview } from "../services/workspace-runtime.js";
import {
  previewLeaseService,
  resolvePreviewBaseUrl,
} from "../services/previews.js";
import {
  parsePreviewRequestTarget,
  proxyPreviewHttp,
} from "../services/preview-proxy.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { notFound } from "../errors.js";

function requestPreviewBaseUrl(req: Request) {
  const configured = process.env.PAPERCLIP_API_URL?.trim() || process.env.PAPERCLIP_RUNTIME_API_URL?.trim();
  if (configured) return resolvePreviewBaseUrl(configured);

  const forwardedProto = req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || req.header("host");
  return resolvePreviewBaseUrl(host ? `${forwardedProto || req.protocol}://${host}` : undefined);
}

export function previewApiRoutes(db: Db) {
  const router = Router();
  const previews = previewLeaseService(db);

  router.get("/companies/:companyId/previews", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await previews.listForCompany(companyId, requestPreviewBaseUrl(req)));
  });

  router.post("/companies/:companyId/previews", validate(createPreviewLeaseSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const lease = await previews.createForRuntimeService({
      companyId,
      runtimeServiceId: req.body.runtimeServiceId,
      baseUrl: requestPreviewBaseUrl(req),
    });
    await pinRuntimeServiceForPreview({
      db,
      runtimeServiceId: lease.runtimeServiceId,
      previewUrl: lease.url,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "preview.created",
      entityType: "preview_lease",
      entityId: lease.id,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        runtimeServiceId: lease.runtimeServiceId,
        slug: lease.slug,
        expiresAt: lease.expiresAt.toISOString(),
      },
    });
    res.status(201).json(lease);
  });

  router.get("/previews/:id", async (req, res) => {
    const lease = await previews.getById(req.params.id as string, requestPreviewBaseUrl(req));
    if (!lease) throw notFound("Preview not found");
    assertCompanyAccess(req, lease.companyId);
    res.json(lease);
  });

  router.delete("/previews/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await previews.getById(id, requestPreviewBaseUrl(req));
    if (!existing) throw notFound("Preview not found");
    assertCompanyAccess(req, existing.companyId);
    const lease = await previews.revoke(id, existing.companyId, requestPreviewBaseUrl(req));
    if (!lease) {
      res.status(204).end();
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "preview.revoked",
      entityType: "preview_lease",
      entityId: lease.id,
      agentId: actor.agentId,
      runId: actor.runId,
      details: { runtimeServiceId: lease.runtimeServiceId, slug: lease.slug },
    });
    res.json(lease);
  });

  return router;
}

export function previewProxyRoutes(db: Db) {
  const router = Router();
  const previews = previewLeaseService(db);

  router.use(async (req, res) => {
    const target = parsePreviewRequestTarget(req.originalUrl);
    if (!target) {
      res.status(404).json({ error: "Preview route not found" });
      return;
    }

    const preview = await previews.getBySlug(target.slug);
    if (!preview) {
      res.status(404).json({ error: "Preview not found" });
      return;
    }
    if (preview.lease.status === "expired") {
      res.status(410).json({ error: "Preview expired" });
      return;
    }
    if (preview.lease.status === "revoked") {
      res.status(410).json({ error: "Preview revoked" });
      return;
    }

    assertCompanyAccess(req, preview.lease.companyId);
    await proxyPreviewHttp(req, res, preview, target);
  });

  return router;
}
