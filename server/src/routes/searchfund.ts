import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { logActivity } from "../services/index.js";
import { readSearchfundConfig, searchfundService, tokensMatch } from "../services/searchfund.js";
import { parseTableQuery } from "../services/searchfund-query.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { forbidden, notFound, unauthorized } from "../errors.js";
import { logger } from "../middleware/logger.js";

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function canViewSearchfund(req: Request, allowedEmails: string[] | null) {
  if (req.actor.type !== "board") return false;
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
  // No allowlist configured: every board member of the company can see it.
  if (!allowedEmails) return true;
  const email = req.actor.userEmail?.trim().toLowerCase();
  return !!email && allowedEmails.includes(email);
}

export function searchfundRoutes(db: Db, storage: StorageService, opts: { env?: Record<string, string | undefined> } = {}) {
  const router = Router();
  const svc = searchfundService(db, storage);
  const config = () => readSearchfundConfig(opts.env ?? process.env);

  function assertViewer(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!canViewSearchfund(req, config().allowedEmails)) {
      throw forbidden("You don't have access to the SearchFund dashboard");
    }
  }

  // A run's layer documents are attached to its tasks around the time its workbook is uploaded; collect them then.
  function scheduleHarvest(companyId: string, identifier: string) {
    for (const delayMs of [0, 60_000, 10 * 60_000]) {
      setTimeout(() => {
        svc.harvestByIdentifier(companyId, identifier).catch((err) =>
          logger.warn({ err, companyId, identifier }, "searchfund harvest failed"));
      }, delayMs).unref();
    }
  }

  // Called by the Apps Scripts with the payloads they already build for the sheets.
  router.post("/companies/:companyId/searchfund/ingest", async (req, res) => {
    const companyId = req.params.companyId as string;
    const { ingestToken } = config();
    if (!ingestToken) throw forbidden("SearchFund ingest is not configured");
    const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const bearer = req.header("authorization")?.replace(/^bearer\s+/i, "").trim();
    const provided = bearer || (typeof body.secret === "string" ? body.secret : null);
    if (!tokensMatch(ingestToken, provided)) throw unauthorized();
    if (!(await svc.companyExists(companyId))) throw notFound("Company not found");

    const action = typeof body.action === "string" ? body.action : body.sheet ? "sheet" : "";
    if (action === "sync_taxonomy") {
      res.json({ ok: true, ...(await svc.syncTaxonomy(companyId, body as never)) });
      return;
    }
    if (action === "sheet") {
      const sheet = body.sheet as Record<string, unknown>;
      const out = await svc.recordScore(companyId, sheet, isPlainObject(body.result) ? { result: body.result } : {});
      // The run's result and layer files are attached to its tasks around now; collect them once they land.
      const summary = (sheet?.niche_summary ?? {}) as Record<string, unknown>;
      if (typeof summary.issue === "string" && summary.issue) scheduleHarvest(companyId, summary.issue);
      res.json({ ok: true, ...out });
      return;
    }
    if (action === "sync_sheet") {
      res.json({
        ok: true,
        ...(await svc.syncSheet(companyId, {
          workbook: body.workbook,
          tab: body.tab,
          position: body.position,
          rows: body.rows,
          tabs: body.tabs,
        })),
      });
      return;
    }
    if (action === "details") {
      res.json({ ok: true, ...(await svc.recordDetails(companyId, { subniche: body.subniche, details: body.details, taxonomyId: body.taxonomy_id })) });
      return;
    }
    if (action === "layer_doc") {
      res.json({ ok: true, ...(await svc.recordLayerDoc(companyId, { issue: body.issue, layerIssue: body.layer_issue, doc: body.doc })) });
      return;
    }
    if (action === "upload_report") {
      const out = await svc.recordFile(companyId, {
        filename: body.filename,
        base64: body.base64,
        taxonomyId: body.taxonomy_id,
      });
      if (out.issue) scheduleHarvest(companyId, out.issue);
      res.json({ ok: true, ...out });
      return;
    }
    res.status(400).json({ ok: false, error: "unknown action" });
  });

  router.get("/companies/:companyId/searchfund/access", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ allowed: canViewSearchfund(req, config().allowedEmails) });
  });

  router.get("/companies/:companyId/searchfund/niches", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertViewer(req, companyId);
    res.json(await svc.listNiches(companyId));
  });

  router.post("/companies/:companyId/searchfund/niches/:nicheId/run", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertViewer(req, companyId);
    const idempotencyKey = typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey.slice(0, 255) : null;
    const result = await svc.runNiche(companyId, req.params.nicheId as string, {
      routineId: config().routineId,
      userId: req.actor.type === "board" ? req.actor.userId ?? null : null,
      idempotencyKey,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "searchfund.niche_run_triggered",
      entityType: "routine_run",
      entityId: result.routineRunId,
      details: { nicheId: req.params.nicheId, status: result.status },
    });
    res.status(202).json(result);
  });

  router.get("/companies/:companyId/searchfund/scores", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertViewer(req, companyId);
    res.json(await svc.listScores(companyId));
  });

  // Taxonomy_Master: columns + counters, a page of rows, and one column's filter values (all server-side).
  router.get("/companies/:companyId/searchfund/niches/columns", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertViewer(req, companyId);
    res.json(await svc.nicheColumns(companyId));
  });

  router.get("/companies/:companyId/searchfund/niches/query", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertViewer(req, companyId);
    res.json(await svc.queryNiches(companyId, parseTableQuery(req.query)));
  });

  router.get("/companies/:companyId/searchfund/niches/facets", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertViewer(req, companyId);
    res.json(await svc.nicheFacets(companyId, String(req.query.column ?? ""), parseTableQuery(req.query)));
  });

  // Scoring Model: the weights behind Taxonomy_Master's Composite Score. Saving recomputes every composite.
  router.get("/companies/:companyId/searchfund/scoring-model", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertViewer(req, companyId);
    res.json(await svc.getScoringModel(companyId));
  });

  router.put("/companies/:companyId/searchfund/scoring-model", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertViewer(req, companyId);
    const result = await svc.saveScoringModel(companyId, req.body?.dimensions);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "searchfund.scoring_model_updated",
      entityType: "company",
      entityId: companyId,
      details: { weights: result.dimensions.map((d) => ({ dimension: d.dimension, weight: d.weight })), updatedNiches: result.updatedNiches },
    });
    res.json(result);
  });

  router.delete("/companies/:companyId/searchfund/scoring-model", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertViewer(req, companyId);
    res.json(await svc.resetScoringModel(companyId));
  });

  router.get("/companies/:companyId/searchfund/scoring", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertViewer(req, companyId);
    res.json(await svc.scoringOverview(companyId));
  });

  router.get("/companies/:companyId/searchfund/scoring/:table/query", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertViewer(req, companyId);
    res.json(await svc.queryScoring(companyId, req.params.table as string, parseTableQuery(req.query)));
  });

  router.get("/companies/:companyId/searchfund/scoring/:table/facets", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertViewer(req, companyId);
    res.json(await svc.scoringFacets(companyId, req.params.table as string, String(req.query.column ?? ""), parseTableQuery(req.query)));
  });

  router.get("/companies/:companyId/searchfund/runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertViewer(req, companyId);
    res.json(await svc.listRuns(companyId));
  });

  router.get("/companies/:companyId/searchfund/files", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertViewer(req, companyId);
    res.json(await svc.listFiles(companyId));
  });

  // Collect run data from the runs' tasks: one run ({ issue: "SEA-123" }) or every run (the backfill).
  router.post("/companies/:companyId/searchfund/harvest", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertViewer(req, companyId);
    const issue = typeof req.body?.issue === "string" ? req.body.issue.trim() : "";
    if (issue) {
      const out = await svc.harvestByIdentifier(companyId, issue);
      if (!out) throw notFound("Run task not found");
      res.json(out);
      return;
    }
    res.json(await svc.harvestAll(companyId));
  });

  router.get("/companies/:companyId/searchfund/runs/:issue/layers", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertViewer(req, companyId);
    res.json(await svc.listLayerDocs(companyId, req.params.issue as string));
  });

  router.get("/companies/:companyId/searchfund/workbooks", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertViewer(req, companyId);
    res.json(await svc.listWorkbooks(companyId));
  });

  router.get("/companies/:companyId/searchfund/workbooks/:workbook/tabs/:tab", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertViewer(req, companyId);
    res.json(await svc.getSheet(companyId, req.params.workbook as string, req.params.tab as string));
  });

  router.get("/companies/:companyId/searchfund/files/:fileId/content", async (req, res, next) => {
    const companyId = req.params.companyId as string;
    assertViewer(req, companyId);
    const file = await svc.getFile(companyId, req.params.fileId as string);
    const object = await storage.getObject(companyId, file.objectKey);
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Length", String(file.byteSize));
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename.replaceAll("\"", "")}"`);
    object.stream.on("error", (err) => next(err));
    object.stream.pipe(res);
  });

  return router;
}
