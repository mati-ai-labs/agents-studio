import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { logActivity } from "../services/index.js";
import {
  buildDashboardBrief,
  companyDashboardsService,
  summarizeDashboard,
  tokenMatchesHash,
  type DashboardRow,
} from "../services/company-dashboards.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { badRequest, forbidden, notFound, unauthorized } from "../errors.js";

export function canViewDashboard(req: Request, dashboard: Pick<DashboardRow, "allowedEmails">) {
  if (req.actor.type === "agent") return true;
  if (req.actor.type !== "board") return false;
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
  const allowed = dashboard.allowedEmails;
  if (!allowed || allowed.length === 0) return true;
  const email = req.actor.userEmail?.trim().toLowerCase();
  return !!email && allowed.includes(email);
}

function actorIds(req: Request) {
  return {
    userId: req.actor.type === "board" ? req.actor.userId ?? null : null,
    agentId: req.actor.type === "agent" ? req.actor.agentId ?? null : null,
  };
}

function body(req: Request) {
  return (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
}

export function companyDashboardRoutes(db: Db, storage?: StorageService) {
  const router = Router();
  const svc = companyDashboardsService(db, storage);

  async function load(req: Request, opts: { manage?: boolean } = {}) {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const dashboard = await svc.getByRef(companyId, req.params.dashboardId as string);
    if (!canViewDashboard(req, dashboard)) throw forbidden("You don't have access to this dashboard");
    if (opts.manage) assertBoard(req);
    return dashboard;
  }

  async function log(req: Request, dashboard: DashboardRow, action: string, details: Record<string, unknown> = {}) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: dashboard.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action,
      entityType: "company_dashboard",
      entityId: dashboard.id,
      details: { name: dashboard.name, slug: dashboard.slug, ...details },
    });
  }

  // External systems push records with the dashboard's ingest token (no Studio session).
  router.post("/companies/:companyId/dashboards/:dashboardId/ingest", async (req, res) => {
    const companyId = req.params.companyId as string;
    const dashboard = await svc.getByRef(companyId, req.params.dashboardId as string).catch(() => null);
    const provided =
      req.header("x-dashboard-token")?.trim() || req.header("authorization")?.replace(/^bearer\s+/i, "").trim();
    if (!dashboard || !tokenMatchesHash(dashboard.ingestTokenHash, provided)) throw unauthorized();
    const input = body(req);
    const replace = Array.isArray(input.replaceCollections) ? input.replaceCollections : [];
    let cleared = 0;
    for (const collection of replace) cleared += (await svc.clearCollection(dashboard, collection)).deleted;
    const deletes = Array.isArray(input.deletes) ? input.deletes : [];
    let deleted = 0;
    for (const item of deletes as Array<Record<string, unknown>>) {
      deleted += (await svc.deleteRecord(dashboard, item?.collection, item?.key)).deleted;
    }
    const records = Array.isArray(input.records) ? (input.records as Array<Record<string, unknown>>) : [];
    const { written } = await svc.putRecords(
      dashboard,
      records.map((r) => ({ collection: r?.collection, key: r?.key, data: r?.data })),
    );
    const files = Array.isArray(input.files) ? (input.files as Array<Record<string, unknown>>) : [];
    const uploaded = [];
    for (const file of files) {
      uploaded.push(await svc.putFile(dashboard, { name: file?.name, contentType: file?.contentType, base64: file?.base64, meta: file?.meta }));
    }
    res.json({ ok: true, written, deleted, cleared, files: uploaded });
  });

  router.get("/companies/:companyId/dashboards", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await svc.list(companyId);
    res.json(rows.filter((row) => canViewDashboard(req, row)).map(summarizeDashboard));
  });

  router.post("/companies/:companyId/dashboards", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board" && req.actor.type !== "agent") throw forbidden();
    const input = body(req);
    const dashboard = await svc.create(companyId, {
      name: input.name,
      slug: input.slug,
      description: input.description,
      allowedEmails: req.actor.type === "board" ? input.allowedEmails : undefined,
      builderAgentId: input.builderAgentId,
    }, actorIds(req));
    await log(req, dashboard, "dashboard.created");
    res.status(201).json(summarizeDashboard(dashboard));
  });

  router.get("/companies/:companyId/dashboards/:dashboardId", async (req, res) => {
    res.json(summarizeDashboard(await load(req)));
  });

  router.patch("/companies/:companyId/dashboards/:dashboardId", async (req, res) => {
    const dashboard = await load(req, { manage: true });
    const input = body(req);
    const updated = await svc.update(dashboard, {
      name: input.name,
      description: input.description,
      allowedEmails: input.allowedEmails,
      allowedRoutineIds: input.allowedRoutineIds,
      builderAgentId: input.builderAgentId,
    });
    await log(req, updated, "dashboard.updated", { changed: Object.keys(input) });
    res.json(summarizeDashboard(updated));
  });

  router.delete("/companies/:companyId/dashboards/:dashboardId", async (req, res) => {
    const dashboard = await load(req, { manage: true });
    await log(req, dashboard, "dashboard.deleted", { currentVersion: dashboard.currentVersion });
    await svc.remove(dashboard);
    res.status(204).end();
  });

  router.post("/companies/:companyId/dashboards/:dashboardId/ingest-token", async (req, res) => {
    const dashboard = await load(req, { manage: true });
    const token = await svc.rotateIngestToken(dashboard);
    await log(req, dashboard, "dashboard.ingest_token_rotated");
    res.json({ token });
  });

  router.delete("/companies/:companyId/dashboards/:dashboardId/ingest-token", async (req, res) => {
    const dashboard = await load(req, { manage: true });
    await svc.revokeIngestToken(dashboard);
    await log(req, dashboard, "dashboard.ingest_token_revoked");
    res.status(204).end();
  });

  // ---- versions ----

  router.get("/companies/:companyId/dashboards/:dashboardId/html", async (req, res) => {
    const dashboard = await load(req);
    const version = req.query.version ? Number(req.query.version) : null;
    if (version !== null && (!Number.isInteger(version) || version < 1)) throw badRequest("version must be a positive integer");
    const row = await svc.getVersionHtml(dashboard, version);
    if (!row) throw notFound("This dashboard has no published version yet");
    res.setHeader("Cache-Control", "private, no-store");
    res.json(row);
  });

  router.get("/companies/:companyId/dashboards/:dashboardId/versions", async (req, res) => {
    res.json(await svc.listVersions(await load(req)));
  });

  router.post("/companies/:companyId/dashboards/:dashboardId/versions", async (req, res) => {
    const dashboard = await load(req);
    const input = body(req);
    const version = await svc.publishVersion(dashboard, { html: input.html, note: input.note, issueId: input.issueId }, actorIds(req));
    await log(req, dashboard, "dashboard.version_published", { version: version.version });
    res.status(201).json(version);
  });

  router.post("/companies/:companyId/dashboards/:dashboardId/versions/:version/activate", async (req, res) => {
    const dashboard = await load(req, { manage: true });
    const version = Number(req.params.version);
    if (!Number.isInteger(version) || version < 1) throw badRequest("version must be a positive integer");
    const updated = await svc.setCurrentVersion(dashboard, version);
    await log(req, dashboard, "dashboard.version_activated", { version, previousVersion: dashboard.currentVersion });
    res.json(summarizeDashboard(updated));
  });

  // ---- records ----

  router.get("/companies/:companyId/dashboards/:dashboardId/data", async (req, res) => {
    res.json(await svc.listCollections(await load(req)));
  });

  router.get("/companies/:companyId/dashboards/:dashboardId/data/:collection", async (req, res) => {
    const dashboard = await load(req);
    res.json(await svc.listRecords(dashboard, req.params.collection, { limit: req.query.limit, offset: req.query.offset }));
  });

  router.get("/companies/:companyId/dashboards/:dashboardId/data/:collection/:key", async (req, res) => {
    const dashboard = await load(req);
    res.json(await svc.getRecord(dashboard, req.params.collection, req.params.key));
  });

  router.put("/companies/:companyId/dashboards/:dashboardId/data/:collection/:key", async (req, res) => {
    const dashboard = await load(req);
    const input = body(req);
    await svc.putRecords(dashboard, [{ collection: req.params.collection, key: req.params.key, data: input.data }]);
    res.json(await svc.getRecord(dashboard, req.params.collection, req.params.key));
  });

  router.delete("/companies/:companyId/dashboards/:dashboardId/data/:collection/:key", async (req, res) => {
    const dashboard = await load(req);
    res.json(await svc.deleteRecord(dashboard, req.params.collection, req.params.key));
  });

  router.delete("/companies/:companyId/dashboards/:dashboardId/data/:collection", async (req, res) => {
    const dashboard = await load(req);
    res.json(await svc.clearCollection(dashboard, req.params.collection));
  });

  router.post("/companies/:companyId/dashboards/:dashboardId/records", async (req, res) => {
    const dashboard = await load(req);
    const input = body(req);
    if (!Array.isArray(input.records)) throw badRequest("records must be an array");
    const result = await svc.putRecords(
      dashboard,
      (input.records as Array<Record<string, unknown>>).map((r) => ({ collection: r?.collection, key: r?.key, data: r?.data })),
    );
    res.json(result);
  });

  // ---- files ----

  router.get("/companies/:companyId/dashboards/:dashboardId/files", async (req, res) => {
    res.json(await svc.listFiles(await load(req)));
  });

  router.post("/companies/:companyId/dashboards/:dashboardId/files", async (req, res) => {
    const dashboard = await load(req);
    const input = body(req);
    const file = await svc.putFile(dashboard, { name: input.name, contentType: input.contentType, base64: input.base64, meta: input.meta });
    res.status(201).json(file);
  });

  router.delete("/companies/:companyId/dashboards/:dashboardId/files/:fileId", async (req, res) => {
    const dashboard = await load(req);
    res.json(await svc.deleteFile(dashboard, req.params.fileId as string));
  });

  router.get("/companies/:companyId/dashboards/:dashboardId/files/:fileId/content", async (req, res, next) => {
    const dashboard = await load(req);
    if (!storage) throw notFound("File storage is not configured");
    const file = await svc.getFile(dashboard, req.params.fileId as string);
    const object = await storage.getObject(dashboard.companyId, file.objectKey);
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Length", String(file.byteSize));
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `attachment; filename="${file.name.replace(/["\\\r\n]/g, "")}"`);
    object.stream.on("error", (err) => next(err));
    object.stream.pipe(res);
  });

  // ---- build / change requests ----

  // The brief the UI puts in the builder issue it creates (same contract every time).
  router.post("/companies/:companyId/dashboards/:dashboardId/requests/draft", async (req, res) => {
    const dashboard = await load(req);
    const input = body(req);
    const request = typeof input.request === "string" ? input.request.trim() : "";
    if (!request) throw badRequest("Describe what you want");
    const kind = input.kind === "build" ? "build" : "change";
    const collections = await svc.listCollections(dashboard);
    res.json({ ...buildDashboardBrief({ dashboard, kind, request, collections }), assigneeAgentId: dashboard.builderAgentId });
  });

  router.post("/companies/:companyId/dashboards/:dashboardId/requests", async (req, res) => {
    const dashboard = await load(req);
    const input = body(req);
    const row = await svc.recordRequest(dashboard, { issueId: input.issueId, kind: input.kind, request: input.request }, actorIds(req));
    await log(req, dashboard, "dashboard.change_requested", { issueId: row.issueId, kind: row.kind });
    res.status(201).json(row);
  });

  router.get("/companies/:companyId/dashboards/:dashboardId/requests", async (req, res) => {
    res.json(await svc.listRequests(await load(req)));
  });

  return router;
}
