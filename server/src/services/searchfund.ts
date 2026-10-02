// SearchFund dashboard: Agent Studio's own store for what the Google Sheets pipeline produces.
// The Apps Scripts forward the same payloads they already handle (taxonomy rows, score.py's sheet
// payload, Layer Data workbooks) to /companies/:companyId/searchfund/ingest; the dashboard reads them here.
import crypto from "node:crypto";
import { and, asc, desc, eq, ilike, inArray, ne, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  assets,
  companies,
  issueAttachments,
  issues,
  routineRuns,
  routineTriggers,
  routines,
  searchfundFiles,
  searchfundLayerDocs,
  searchfundNiches,
  searchfundScores,
  searchfundSheets,
} from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { routineService } from "./routines.js";
import { FACET_LIMIT, NUMERIC_RE, facetRows, inferColumnType, queryRows, sortFacets, type Facet, type TableQuery } from "./searchfund-query.js";
import { buildScoringTables, type TableColumn } from "./searchfund-tables.js";

// Same mapping as the sheet writer's STATUS_WORDS.
const STATUS_WORDS: Record<string, string> = {
  COMPLETE: "Done",
  PARTIAL: "Done – partial",
  HOLD_GATES: "On hold – gates",
  INELIGIBLE: "Ineligible",
};

// Same columns the dashboard trigger passes to the orchestrator as niche_context.
const CONTEXT_HEADERS =
  /^(Domain|Niche|Sub-Niche|Micro-Niche \(Descriptive Name\))$|What The Business|Unit of Work|Who Buys|NAICS|NAPCS|Classification Basis/i;
const NAME_HEADER = "Micro-Niche (Short Name)";
const ID_HEADER = "Taxonomy ID";
const RESEARCH_STATUS_HEADERS = ["Agent Research Status", "Research Status"];
const RUN_STATUS_HEADER = "Run Status";
// Columns the sheet uses for its own controls; they mean nothing outside the sheet.
const SHEET_CONTROL_HEADERS = /RUN AGENT WORKFLOW|^Research Task$/i;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type SearchfundAccessConfig = {
  ingestToken: string | null;
  routineId: string | null;
  allowedEmails: string[] | null;
};

export function readSearchfundConfig(env: Record<string, string | undefined> = process.env): SearchfundAccessConfig {
  const emails = (env.SEARCHFUND_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return {
    ingestToken: env.SEARCHFUND_INGEST_TOKEN?.trim() || null,
    routineId: env.SEARCHFUND_ROUTINE_ID?.trim() || null,
    allowedEmails: emails.length > 0 ? emails : null,
  };
}

export function tokensMatch(expected: string, provided: string | null | undefined) {
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function str(value: unknown) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function num(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDate(value: unknown) {
  const text = str(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Forced_Labour_Layer_Data_SEA-293.xlsx" -> "SEA-293" */
export function issueFromFilename(filename: string) {
  const match = filename.match(/_([A-Z][A-Z0-9]*-\d+)\.[a-z0-9]+$/i);
  return match ? match[1].toUpperCase() : null;
}

export const SEARCHFUND_WORKBOOKS = ["dashboard", "scoring"] as const;
export type SearchfundWorkbook = (typeof SEARCHFUND_WORKBOOKS)[number];

/** Cells as strings; trailing empty rows and columns dropped (Sheets pads every tab to its grid size). */
export function normalizeSheetRows(rows: unknown): string[][] {
  if (!Array.isArray(rows)) return [];
  const grid = rows.map((row) => (Array.isArray(row) ? row.map((cell) => (cell === null || cell === undefined ? "" : String(cell))) : []));
  let lastRow = grid.length - 1;
  while (lastRow >= 0 && grid[lastRow].every((cell) => cell === "")) lastRow--;
  const trimmed = grid.slice(0, lastRow + 1);
  let width = 0;
  for (const row of trimmed) {
    for (let i = row.length - 1; i >= 0; i--) {
      if (row[i] !== "") {
        width = Math.max(width, i + 1);
        break;
      }
    }
  }
  return trimmed.map((row) => Array.from({ length: width }, (_v, i) => row[i] ?? ""));
}

export type TaxonomySyncInput = { headers: string[]; rows: unknown[][]; firstRow?: number };

export function parseTaxonomyRows(input: TaxonomySyncInput) {
  const headers = input.headers.map((header) => str(header).replace(/^▶\s*/, ""));
  const col = (name: string) => headers.indexOf(name);
  const idCol = col(ID_HEADER) >= 0 ? col(ID_HEADER) : 0;
  const nameCol = col(NAME_HEADER);
  const researchCol = RESEARCH_STATUS_HEADERS.map(col).find((index) => index >= 0) ?? -1;
  const runCol = col(RUN_STATUS_HEADER);
  const firstRow = input.firstRow ?? 2;
  const parsed: Array<{
    taxonomyId: string;
    shortName: string;
    fields: Array<{ header: string; value: string }>;
    researchStatus: string | null;
    runStatus: string | null;
    sheetRow: number;
  }> = [];
  input.rows.forEach((row, index) => {
    if (!Array.isArray(row)) return;
    const taxonomyId = str(row[idCol]);
    if (!taxonomyId) return;
    const fields = headers
      .map((header, i) => ({ header, value: str(row[i]) }))
      .filter((field) => field.header && !SHEET_CONTROL_HEADERS.test(field.header));
    parsed.push({
      taxonomyId,
      shortName: (nameCol >= 0 ? str(row[nameCol]) : "") || taxonomyId,
      fields,
      researchStatus: researchCol >= 0 ? str(row[researchCol]) || null : null,
      runStatus: runCol >= 0 ? str(row[runCol]) || null : null,
      sheetRow: firstRow + index,
    });
  });
  return parsed;
}

export function nicheContext(fields: Array<{ header: string; value: string }>) {
  return fields
    .filter((field) => field.value && CONTEXT_HEADERS.test(field.header))
    .map((field) => `${field.header}: ${field.value}`)
    .join("\n");
}

type ScoreRow = typeof searchfundScores.$inferSelect;

/** Writer's rerank_: COMPLETE niches by Decision Score (desc) get ranks, the rest follow unranked. */
export function rankScores<T extends Pick<ScoreRow, "scoringStatus" | "decisionScore">>(rows: T[]) {
  const sorted = [...rows].sort((a, b) => {
    const ca = a.scoringStatus === "COMPLETE" ? 0 : 1;
    const cb = b.scoringStatus === "COMPLETE" ? 0 : 1;
    const da = a.decisionScore ?? Number.NEGATIVE_INFINITY;
    const dbScore = b.decisionScore ?? Number.NEGATIVE_INFINITY;
    return ca - cb || dbScore - da;
  });
  let rank = 0;
  return sorted.map((row) => ({ ...row, rank: row.scoringStatus === "COMPLETE" ? ++rank : null }));
}

/** The keyed copy of a taxonomy row used for SQL filters/sort, and its search text. */
export function nicheRow(input: { taxonomyId: string; fields: Array<{ header: string; value: string }> }) {
  const row: Record<string, string> = {};
  for (const f of input.fields) if (f.header) row[f.header] = f.value ?? "";
  row[TAXONOMY_ID_COLUMN] = input.taxonomyId;
  const searchText = [input.taxonomyId, ...input.fields.map((f) => f.value)].filter(Boolean).join(" ").toLowerCase();
  return { row, searchText };
}

const TAXONOMY_ID_COLUMN = "Taxonomy ID";
export const COMPOSITE_COLUMN = "Composite Score (0-5)";
const SCORING_MODEL_TAB = "Scoring_Model";
const STUDIO_WORKBOOK = "studio";

/** Scoring_Model rows numbered 1..n: [#, Dimension, Weight %, Derivation, Score 1 =, Score 5 =]. */
export function parseScoringModel(rows: string[][]) {
  return rows
    .filter((r) => /^\d+$/.test(String(r[0] ?? "").trim()))
    .map((r) => ({
      dimension: String(r[1] ?? "").trim(),
      weight: Number(String(r[2] ?? "").replace("%", "")) / 100,
      derivation: String(r[3] ?? "").trim(),
      score1: String(r[4] ?? "").trim(),
      score5: String(r[5] ?? "").trim(),
    }));
}
const GATE_FLAG_HIGHLIGHT = {
  "OWNERSHIP BLOCKED": { bg: "#ffc7ce", fg: "#9c0006" },
  "PRICING RISK": { bg: "#ffeb9c", fg: "#9c6500" },
};

/** The dimension weights from the dashboard's Scoring_Model tab, in dimension order (rows numbered 1..n with a "12%" weight). */
export function scoringModelWeights(rows: string[][]): Array<{ dimension: string; weight: number }> | null {
  const out: Array<{ dimension: string; weight: number }> = [];
  for (const r of rows) {
    const n = Number.parseInt(String(r[0] ?? "").trim(), 10);
    const pct = r.find((c) => /^\s*\d+(\.\d+)?\s*%\s*$/.test(String(c ?? "")));
    if (!Number.isFinite(n) || String(n) !== String(r[0]).trim() || pct === undefined) continue;
    out[n - 1] = { dimension: String(r[1] ?? "").trim(), weight: Number(String(pct).replace("%", "")) / 100 };
  }
  return out.length && out.every(Boolean) ? out : null;
}

/** Taxonomy_Master's Composite Score formula: each "Score: …" column times its Scoring_Model weight, summed. */
export function compositeScore(fields: Array<{ header: string; value: string }>, weights: number[]): string | null {
  const scores = fields.filter((f) => /^Score:/i.test(f.header));
  if (scores.length !== weights.length) return null;
  let total = 0;
  for (let i = 0; i < scores.length; i++) {
    const v = Number(String(scores[i].value).trim());
    if (String(scores[i].value).trim() === "" || !Number.isFinite(v)) return null;
    total += v * weights[i];
  }
  return total.toFixed(2);
}
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function searchfundService(db: Db, storage?: StorageService) {
  const routinesSvc = routineService(db);

  async function syncTaxonomy(companyId: string, input: TaxonomySyncInput) {
    if (!Array.isArray(input.headers) || !Array.isArray(input.rows)) {
      throw badRequest("sync_taxonomy needs headers and rows arrays");
    }
    const rows = parseTaxonomyRows(input);
    const now = new Date();
    for (const parsed of rows) {
      const row = { ...parsed, ...nicheRow(parsed) };
      await db
        .insert(searchfundNiches)
        .values({ companyId, ...row, updatedAt: now })
        .onConflictDoUpdate({
          target: [searchfundNiches.companyId, searchfundNiches.taxonomyId],
          set: {
            shortName: row.shortName,
            fields: row.fields,
            row: row.row,
            searchText: row.searchText,
            researchStatus: row.researchStatus,
            runStatus: row.runStatus,
            sheetRow: row.sheetRow,
            updatedAt: now,
          },
        });
    }
    await recomputeComposites(companyId);
    return { niches: rows.length };
  }

  /** Re-derive every niche's Composite Score from the synced Scoring_Model weights (the sheet's linked formula). */
  async function recomputeComposites(companyId: string) {
    const weights = (await scoringModel(companyId))?.map((w) => w.weight);
    if (!weights) return { updated: 0 };
    const niches = await db
      .select({ id: searchfundNiches.id, taxonomyId: searchfundNiches.taxonomyId, fields: searchfundNiches.fields, row: searchfundNiches.row })
      .from(searchfundNiches)
      .where(eq(searchfundNiches.companyId, companyId));
    let updated = 0;
    for (const n of niches) {
      const composite = compositeScore(n.fields, weights);
      if (composite === null || n.row[COMPOSITE_COLUMN] === composite) continue;
      const has = n.fields.some((f) => f.header === COMPOSITE_COLUMN);
      const fields = has
        ? n.fields.map((f) => (f.header === COMPOSITE_COLUMN ? { ...f, value: composite } : f))
        : [...n.fields, { header: COMPOSITE_COLUMN, value: composite }];
      await db.update(searchfundNiches).set({ fields, ...nicheRow({ taxonomyId: n.taxonomyId, fields }) }).where(eq(searchfundNiches.id, n.id));
      updated++;
    }
    return { updated };
  }

  // The Scoring_Model the dashboard uses: Agent Studio's edited copy when there is one, else the synced sheet tab.
  // Edits live under workbook "studio" so a later sync of the Google sheet never overwrites them.
  async function scoringModelSheet(companyId: string) {
    const rows = await db
      .select({ workbook: searchfundSheets.workbook, rows: searchfundSheets.rows, syncedAt: searchfundSheets.syncedAt })
      .from(searchfundSheets)
      .where(and(
        eq(searchfundSheets.companyId, companyId),
        inArray(searchfundSheets.workbook, [STUDIO_WORKBOOK, "dashboard"]),
        eq(searchfundSheets.tab, SCORING_MODEL_TAB),
      ));
    return rows.find((r) => r.workbook === STUDIO_WORKBOOK) ?? rows.find((r) => r.workbook === "dashboard") ?? null;
  }

  async function scoringModel(companyId: string) {
    const model = await scoringModelSheet(companyId);
    return model ? scoringModelWeights(model.rows) : null;
  }

  /** The Scoring Model tab: one entry per dimension with its weight, the Taxonomy_Master column it weights, and its rubric. */
  async function getScoringModel(companyId: string) {
    const model = await scoringModelSheet(companyId);
    const [first] = await db
      .select({ fields: searchfundNiches.fields })
      .from(searchfundNiches)
      .where(eq(searchfundNiches.companyId, companyId))
      .orderBy(searchfundNiches.sheetRow)
      .limit(1);
    const scoreColumns = (first?.fields ?? []).map((f) => f.header).filter((h) => /^Score:/i.test(h));
    if (!model) return { source: null, updatedAt: null, dimensions: [], notes: [] };
    const dimensions = parseScoringModel(model.rows).map((d, i) => ({ ...d, scoreColumn: scoreColumns[i] ?? null }));
    // Notes are the tier/override lines under the TOTAL row.
    const totalAt = model.rows.findIndex((r) => /^total$/i.test(str(r[1])));
    const notes = model.rows.slice(totalAt + 1).map((r) => str(r[1])).filter(Boolean);
    return { source: model.workbook === STUDIO_WORKBOOK ? "studio" : "sheet", updatedAt: model.syncedAt, dimensions, notes };
  }

  /** Save edited dimensions (weights as fractions) and recompute every niche's Composite Score. */
  async function saveScoringModel(companyId: string, input: unknown) {
    const list = Array.isArray(input) ? input : [];
    const current = await getScoringModel(companyId);
    if (!current.dimensions.length) throw badRequest("No Scoring_Model has been synced yet");
    if (list.length !== current.dimensions.length) throw badRequest(`Expected ${current.dimensions.length} dimensions`);
    const rows: string[][] = [["", "Dimension", "Weight", "Derivation", "Score 1 =", "Score 5 ="]];
    list.forEach((raw, i) => {
      const d = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
      const weight = Number(d.weight);
      if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw badRequest(`Weight for dimension ${i + 1} must be between 0% and 100%`);
      const prev = current.dimensions[i];
      const text = (v: unknown, fallback: string) => (typeof v === "string" ? v.trim().slice(0, 500) : fallback);
      rows.push([
        String(i + 1),
        text(d.dimension, prev.dimension) || prev.dimension,
        `${Math.round(weight * 10000) / 100}%`,
        text(d.derivation, prev.derivation),
        text(d.score1, prev.score1),
        text(d.score5, prev.score5),
      ]);
    });
    const total = list.reduce((sum: number, d) => sum + Number((d as Record<string, unknown>).weight), 0);
    rows.push(["", "TOTAL", `${Math.round(total * 10000) / 100}%`, "", "", ""]);
    for (const note of current.notes) rows.push(["", note, "", "", "", ""]);
    const values = { position: 0, rows, rowCount: rows.length, colCount: 6, syncedAt: new Date() };
    await db
      .insert(searchfundSheets)
      .values({ companyId, workbook: STUDIO_WORKBOOK, tab: SCORING_MODEL_TAB, ...values })
      .onConflictDoUpdate({ target: [searchfundSheets.companyId, searchfundSheets.workbook, searchfundSheets.tab], set: values });
    const { updated } = await recomputeComposites(companyId);
    return { ...(await getScoringModel(companyId)), updatedNiches: updated };
  }

  /** Drop the edited copy and go back to the Google sheet's weights. */
  async function resetScoringModel(companyId: string) {
    await db.delete(searchfundSheets).where(and(
      eq(searchfundSheets.companyId, companyId),
      eq(searchfundSheets.workbook, STUDIO_WORKBOOK),
      eq(searchfundSheets.tab, SCORING_MODEL_TAB),
    ));
    const { updated } = await recomputeComposites(companyId);
    return { ...(await getScoringModel(companyId)), updatedNiches: updated };
  }

  async function nicheByTaxonomyId(companyId: string, taxonomyId: string | null) {
    if (!taxonomyId) return null;
    return db
      .select()
      .from(searchfundNiches)
      .where(and(eq(searchfundNiches.companyId, companyId), eq(searchfundNiches.taxonomyId, taxonomyId)))
      .then((rows) => rows[0] ?? null);
  }

  async function issueIdByIdentifier(companyId: string, identifier: string | null) {
    if (!identifier) return null;
    const row = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.identifier, identifier)))
      .then((rows) => rows[0] ?? null);
    return row?.id ?? null;
  }

  async function recordScore(
    companyId: string,
    sheet: Record<string, unknown>,
    extra: { result?: Record<string, unknown>; runIssueId?: string } = {},
  ) {
    const summary = sheet.niche_summary;
    if (!isRecord(summary) || !str(summary.subniche)) throw badRequest("missing sheet.niche_summary.subniche");
    // The niche this run belongs to: by Taxonomy ID, else the niche whose Qualify run this is.
    const byRun = extra.runIssueId
      ? await db.select().from(searchfundNiches)
          .where(and(eq(searchfundNiches.companyId, companyId), eq(searchfundNiches.linkedIssueId, extra.runIssueId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const taxonomyId = str(summary.taxonomy_id) || byRun?.taxonomyId || null;
    const niche = (await nicheByTaxonomyId(companyId, taxonomyId)) ?? byRun;
    // Writer's shortNameFor_: file every run under the dashboard's short name, whatever the agent called it.
    const subniche = niche?.shortName || str(summary.subniche);
    const rename = <T,>(part: T): T => (isRecord(part) ? ({ ...part, subniche } as T) : part);
    const values = {
      subniche,
      taxonomyId,
      issue: str(summary.issue) || null,
      scoringStatus: str(summary.scoring_status) || null,
      decisionScore: num(summary.decision_score),
      nicheSummary: rename(summary),
      crossNicheSummary: isRecord(sheet.cross_niche_summary) ? rename(sheet.cross_niche_summary) : null,
      crossNicheComparison: isRecord(sheet.cross_niche_comparison) ? rename(sheet.cross_niche_comparison) : null,
      details: isRecord(sheet.details) ? sheet.details : null,
      // Only a harvested result carries this; a sheet-only update must not wipe it.
      ...(extra.result ? { result: extra.result } : {}),
      generatedAt: parseDate(summary.generated_at),
      updatedAt: new Date(),
    };
    // One row per niche: a re-run (or an older row filed under a long name) is replaced.
    const existing = taxonomyId
      ? await db
        .select({ id: searchfundScores.id })
        .from(searchfundScores)
        .where(and(eq(searchfundScores.companyId, companyId), eq(searchfundScores.taxonomyId, taxonomyId)))
      : [];
    if (existing.length > 0) {
      const [keep, ...stale] = existing;
      if (stale.length) await db.delete(searchfundScores).where(inArray(searchfundScores.id, stale.map((r) => r.id)));
      await db
        .delete(searchfundScores)
        .where(and(
          eq(searchfundScores.companyId, companyId),
          eq(searchfundScores.subniche, subniche),
          ne(searchfundScores.id, keep.id),
        ));
      await db.update(searchfundScores).set(values).where(eq(searchfundScores.id, keep.id));
    } else {
      await db
        .insert(searchfundScores)
        .values({ companyId, ...values })
        .onConflictDoUpdate({ target: [searchfundScores.companyId, searchfundScores.subniche], set: values });
    }

    // Writer's markTaxonomyRow_: the originating niche is finished and linked to its task.
    if (niche) {
      const word = STATUS_WORDS[values.scoringStatus ?? ""] ?? values.scoringStatus ?? "Done";
      const score = values.decisionScore !== null ? ` · Decision ${values.decisionScore}` : "";
      const linkedIssueId = (await issueIdByIdentifier(companyId, values.issue)) ?? niche.linkedIssueId;
      const stamp = new Date().toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
      const runStatus = `Finished · ${word}${score} · ${stamp}`;
      // Keep the row's own columns in step so the dashboard table shows the finished run.
      const patch: Record<string, string> = { "Agent Research Status": word, "Run Status": runStatus };
      if (values.issue) patch["Research Task"] = values.issue;
      const fields = niche.fields.map((f) => (f.header in patch ? { ...f, value: patch[f.header] } : f));
      await db
        .update(searchfundNiches)
        .set({
          researchStatus: word,
          runStatus,
          linkedIssueId,
          fields,
          ...nicheRow({ taxonomyId: niche.taxonomyId, fields }),
          updatedAt: new Date(),
        })
        .where(eq(searchfundNiches.id, niche.id));
    }
    return { subniche };
  }

  /** Writer's detailsOnly_: replace just the Layer / Criteria / Non-Core detail rows of a scored niche. */
  async function recordDetails(companyId: string, input: { subniche: unknown; details: unknown; taxonomyId?: unknown }) {
    const subniche = str(input.subniche);
    const taxonomyId = str(input.taxonomyId);
    if ((!subniche && !taxonomyId) || !isRecord(input.details)) throw badRequest("details needs subniche and details");
    // Scores are filed under the dashboard short name, so prefer the Taxonomy ID when the caller has it.
    const match = taxonomyId ? eq(searchfundScores.taxonomyId, taxonomyId) : eq(searchfundScores.subniche, subniche);
    const updated = await db
      .update(searchfundScores)
      .set({ details: input.details, updatedAt: new Date() })
      .where(and(eq(searchfundScores.companyId, companyId), match))
      .returning({ subniche: searchfundScores.subniche });
    if (updated.length === 0) throw notFound(`No scored niche named ${subniche || taxonomyId}`);
    return { subniche: updated[0].subniche };
  }

  async function recordFile(companyId: string, input: { filename: unknown; base64: unknown; taxonomyId?: unknown }) {
    if (!storage) throw new Error("searchfund file storage is not configured");
    const filename = str(input.filename).replace(/[\\/]/g, "_");
    const base64 = typeof input.base64 === "string" ? input.base64 : "";
    if (!filename || !base64) throw badRequest("upload_report needs filename and base64");
    const body = Buffer.from(base64, "base64");
    if (body.length === 0) throw badRequest("upload_report file is empty");
    const contentType = filename.toLowerCase().endsWith(".xlsx") ? XLSX_CONTENT_TYPE : "application/octet-stream";
    const stored = await storage.putFile({
      companyId,
      namespace: "searchfund",
      originalFilename: filename,
      contentType,
      body,
    });
    const issue = issueFromFilename(filename);
    let taxonomyId = str(input.taxonomyId) || null;
    if (!taxonomyId && issue) {
      const score = await db
        .select({ taxonomyId: searchfundScores.taxonomyId })
        .from(searchfundScores)
        .where(and(eq(searchfundScores.companyId, companyId), eq(searchfundScores.issue, issue)))
        .then((rows) => rows[0] ?? null);
      taxonomyId = score?.taxonomyId ?? null;
    }
    const previous = await db
      .select({ objectKey: searchfundFiles.objectKey })
      .from(searchfundFiles)
      .where(and(eq(searchfundFiles.companyId, companyId), eq(searchfundFiles.filename, filename)))
      .then((rows) => rows[0] ?? null);
    const values = {
      issue,
      taxonomyId,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      updatedAt: new Date(),
    };
    const [row] = await db
      .insert(searchfundFiles)
      .values({ companyId, filename, ...values })
      .onConflictDoUpdate({ target: [searchfundFiles.companyId, searchfundFiles.filename], set: values })
      .returning({ id: searchfundFiles.id });
    if (previous && previous.objectKey !== stored.objectKey) {
      await storage.deleteObject(companyId, previous.objectKey).catch(() => undefined);
    }
    return { id: row.id, name: filename, issue };
  }

  async function companyExists(companyId: string) {
    if (!UUID_RE.test(companyId)) return false;
    const row = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    return !!row;
  }

  /** One tab of a workbook, as displayed in Sheets. `tabs` (all current tab names) prunes deleted tabs. */
  async function syncSheet(
    companyId: string,
    input: { workbook: unknown; tab: unknown; position?: unknown; rows: unknown; tabs?: unknown },
  ) {
    const workbook = str(input.workbook) as SearchfundWorkbook;
    const tab = str(input.tab);
    if (!SEARCHFUND_WORKBOOKS.includes(workbook)) throw badRequest("workbook must be dashboard or scoring");
    if (!tab) throw badRequest("sync_sheet needs a tab name");
    const rows = normalizeSheetRows(input.rows);
    const values = {
      position: num(input.position) ?? 0,
      rows,
      rowCount: rows.length,
      colCount: rows[0]?.length ?? 0,
      syncedAt: new Date(),
    };
    await db
      .insert(searchfundSheets)
      .values({ companyId, workbook, tab, ...values })
      .onConflictDoUpdate({
        target: [searchfundSheets.companyId, searchfundSheets.workbook, searchfundSheets.tab],
        set: values,
      });
    if (Array.isArray(input.tabs)) {
      const keep = input.tabs.map(str).filter(Boolean);
      if (keep.length > 0) {
        const existing = await db
          .select({ id: searchfundSheets.id, tab: searchfundSheets.tab })
          .from(searchfundSheets)
          .where(and(eq(searchfundSheets.companyId, companyId), eq(searchfundSheets.workbook, workbook)));
        const stale = existing.filter((row) => !keep.includes(row.tab)).map((row) => row.id);
        if (stale.length) await db.delete(searchfundSheets).where(inArray(searchfundSheets.id, stale));
      }
    }
    if (workbook === "dashboard" && tab === "Taxonomy_Master" && rows.length > 1) {
      await syncTaxonomy(companyId, { headers: rows[0], rows: rows.slice(1), firstRow: 2 });
    }
    if (workbook === "dashboard" && tab === SCORING_MODEL_TAB) await recomputeComposites(companyId);
    return { workbook, tab, rows: values.rowCount, cols: values.colCount };
  }

  async function listWorkbooks(companyId: string) {
    const rows = await db
      .select({
        workbook: searchfundSheets.workbook,
        tab: searchfundSheets.tab,
        position: searchfundSheets.position,
        rowCount: searchfundSheets.rowCount,
        colCount: searchfundSheets.colCount,
        syncedAt: searchfundSheets.syncedAt,
      })
      .from(searchfundSheets)
      .where(eq(searchfundSheets.companyId, companyId))
      .orderBy(searchfundSheets.workbook, searchfundSheets.position, searchfundSheets.tab);
    return SEARCHFUND_WORKBOOKS.map((workbook) => ({
      workbook,
      tabs: rows.filter((row) => row.workbook === workbook).map(({ workbook: _w, ...tab }) => tab),
    }));
  }

  async function getSheet(companyId: string, workbook: string, tab: string) {
    const row = await db
      .select()
      .from(searchfundSheets)
      .where(and(
        eq(searchfundSheets.companyId, companyId),
        eq(searchfundSheets.workbook, workbook),
        eq(searchfundSheets.tab, tab),
      ))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Sheet not found");
    return { workbook: row.workbook, tab: row.tab, rows: row.rows, syncedAt: row.syncedAt };
  }

  async function readJsonObject(companyId: string, objectKey: string): Promise<Record<string, unknown> | null> {
    if (!storage) return null;
    try {
      const object = await storage.getObject(companyId, objectKey);
      const chunks: Buffer[] = [];
      for await (const chunk of object.stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return isRecord(value) ? value : null;
    } catch {
      return null;
    }
  }

  async function jsonAttachments(companyId: string, issueIds: string[], filenameLike: string) {
    if (issueIds.length === 0) return [];
    return db
      .select({
        issueId: issueAttachments.issueId,
        identifier: issues.identifier,
        objectKey: assets.objectKey,
        filename: assets.originalFilename,
        createdAt: issueAttachments.createdAt,
      })
      .from(issueAttachments)
      .innerJoin(assets, eq(assets.id, issueAttachments.assetId))
      .innerJoin(issues, eq(issues.id, issueAttachments.issueId))
      .where(and(
        eq(issueAttachments.companyId, companyId),
        inArray(issueAttachments.issueId, issueIds),
        ilike(assets.originalFilename, filenameLike),
      ))
      .orderBy(asc(issueAttachments.createdAt));
  }

  /**
   * Pull one qualification run's full results out of Agent Studio itself: the score.py result attached to the
   * run's task, and the L0–L8 research documents attached to the layer tasks that report back to it.
   */
  async function harvestRun(companyId: string, runIssueId: string) {
    const run = await db
      .select({ id: issues.id, identifier: issues.identifier })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, runIssueId)))
      .then((rows) => rows[0] ?? null);
    if (!run?.identifier) throw notFound("Run task not found");

    let scored = false;
    const results = await jsonAttachments(companyId, [run.id], "%\\_scoring.json");
    const latest = results[results.length - 1];
    if (latest) {
      const result = await readJsonObject(companyId, latest.objectKey);
      if (result && isRecord(result.sheet) && isRecord(result.sheet.niche_summary)) {
        const { sheet, ...rest } = result;
        const summary = sheet.niche_summary as Record<string, unknown>;
        if (!str(summary.issue)) summary.issue = run.identifier;
        await recordScore(companyId, sheet as Record<string, unknown>, { result: rest, runIssueId: run.id });
        scored = true;
      }
    }

    const layerTasks = await db
      .select({ id: issues.id })
      .from(routineRuns)
      .innerJoin(issues, eq(issues.id, routineRuns.linkedIssueId))
      .where(and(eq(routineRuns.companyId, companyId), eq(routineRuns.callbackIssueId, run.id)));
    const docs = await jsonAttachments(companyId, [...new Set(layerTasks.map((t) => t.id))], "%.json");
    const byLayer = new Map<string, { doc: Record<string, unknown>; layerIssue: string | null }>();
    for (const attachment of docs) {
      const doc = await readJsonObject(companyId, attachment.objectKey);
      const layer = doc && isRecord(doc.layer) ? str(doc.layer.id) : "";
      if (doc && /^L[0-8]$/.test(layer)) byLayer.set(layer, { doc, layerIssue: attachment.identifier }); // latest wins
    }
    for (const [layerId, { doc, layerIssue }] of byLayer) {
      await db
        .insert(searchfundLayerDocs)
        .values({ companyId, runIssue: run.identifier, layerId, layerIssue, doc, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [searchfundLayerDocs.companyId, searchfundLayerDocs.runIssue, searchfundLayerDocs.layerId],
          set: { layerIssue, doc, updatedAt: new Date() },
        });
    }
    return { run: run.identifier, scored, layers: [...byLayer.keys()].sort() };
  }

  async function harvestByIdentifier(companyId: string, identifier: string) {
    const run = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.identifier, identifier)))
      .then((rows) => rows[0] ?? null);
    return run ? harvestRun(companyId, run.id) : null;
  }

  /** Backfill: every run that has a score.py result attached, oldest first so a niche ends on its latest run. */
  async function harvestAll(companyId: string) {
    const rows = await db
      .select({ issueId: issueAttachments.issueId, createdAt: issueAttachments.createdAt })
      .from(issueAttachments)
      .innerJoin(assets, eq(assets.id, issueAttachments.assetId))
      .where(and(eq(issueAttachments.companyId, companyId), ilike(assets.originalFilename, "%\\_scoring.json")))
      .orderBy(asc(issueAttachments.createdAt));
    const lastSeen = new Map<string, number>();
    rows.forEach((row, index) => lastSeen.set(row.issueId, index));
    const ordered = [...lastSeen.entries()].sort((a, b) => a[1] - b[1]).map(([issueId]) => issueId);
    const runs = [];
    for (const issueId of ordered) runs.push(await harvestRun(companyId, issueId));
    return { runs: runs.length, scored: runs.filter((r) => r.scored).length, details: runs };
  }

  async function listLayerDocs(companyId: string, runIssue: string) {
    const rows = await db
      .select()
      .from(searchfundLayerDocs)
      .where(and(eq(searchfundLayerDocs.companyId, companyId), eq(searchfundLayerDocs.runIssue, runIssue)))
      .orderBy(searchfundLayerDocs.layerId);
    return rows.map((row) => ({ layerId: row.layerId, layerIssue: row.layerIssue, doc: row.doc, updatedAt: row.updatedAt }));
  }

  /** Runs that have layer JSON stored, newest first, with the niche and score they produced. */
  async function listRuns(companyId: string) {
    const docs = await db
      .select({ runIssue: searchfundLayerDocs.runIssue, layerId: searchfundLayerDocs.layerId, doc: searchfundLayerDocs.doc, updatedAt: searchfundLayerDocs.updatedAt })
      .from(searchfundLayerDocs)
      .where(eq(searchfundLayerDocs.companyId, companyId));
    const scores = await listScores(companyId);
    const scoreByIssue = new Map(scores.filter((s) => s.issue).map((s) => [s.issue as string, s]));
    const runs = new Map<string, { issue: string; microNiche: string | null; niche: string | null; asOf: string | null; layers: string[]; updatedAt: Date }>();
    for (const d of docs) {
      const doc = (isRecord(d.doc) ? d.doc : {}) as Record<string, unknown>;
      const nb = isRecord(doc.niche_boundary) ? doc.niche_boundary : {};
      const meta = isRecord(doc.run_metadata) ? doc.run_metadata : {};
      const run = runs.get(d.runIssue) ?? { issue: d.runIssue, microNiche: null, niche: null, asOf: null, layers: [], updatedAt: d.updatedAt };
      run.microNiche ??= str(nb.micro_niche) || null;
      run.niche ??= [str(nb.niche), str(nb.sub_niche)].filter(Boolean).join(" → ") || null;
      run.asOf ??= str(meta.as_of_date) || null;
      run.layers.push(d.layerId);
      if (d.updatedAt > run.updatedAt) run.updatedAt = d.updatedAt;
      runs.set(d.runIssue, run);
    }
    const files = await db
      .select({ id: searchfundFiles.id, issue: searchfundFiles.issue })
      .from(searchfundFiles)
      .where(eq(searchfundFiles.companyId, companyId));
    const fileByIssue = new Map(files.filter((f) => f.issue).map((f) => [f.issue as string, f.id]));
    return [...runs.values()]
      .map((run) => {
        const score = scoreByIssue.get(run.issue);
        return {
          ...run,
          layers: run.layers.sort(),
          subniche: score?.subniche ?? null,
          taxonomyId: score?.taxonomyId ?? null,
          scoringStatus: score?.scoringStatus ?? null,
          decisionScore: score?.decisionScore ?? null,
          rank: score?.rank ?? null,
          fileId: fileByIssue.get(run.issue) ?? null,
        };
      })
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async function listNiches(companyId: string) {
    const rows = await db
      .select({
        niche: searchfundNiches,
        issueIdentifier: issues.identifier,
        issueStatus: issues.status,
        issueTitle: issues.title,
      })
      .from(searchfundNiches)
      .leftJoin(issues, eq(searchfundNiches.linkedIssueId, issues.id))
      .where(eq(searchfundNiches.companyId, companyId))
      .orderBy(searchfundNiches.sheetRow, searchfundNiches.taxonomyId);
    const scored = await db
      .select({ taxonomyId: searchfundScores.taxonomyId, decisionScore: searchfundScores.decisionScore })
      .from(searchfundScores)
      .where(eq(searchfundScores.companyId, companyId));
    const scoreByTaxonomy = new Map(scored.filter((s) => s.taxonomyId).map((s) => [s.taxonomyId!, s.decisionScore]));
    return rows.map(({ niche, issueIdentifier, issueStatus, issueTitle }) => ({
      id: niche.id,
      taxonomyId: niche.taxonomyId,
      shortName: niche.shortName,
      fields: niche.fields,
      researchStatus: niche.researchStatus,
      runStatus: niche.runStatus,
      sheetRow: niche.sheetRow,
      updatedAt: niche.updatedAt,
      decisionScore: scoreByTaxonomy.get(niche.taxonomyId) ?? null,
      linkedIssue: niche.linkedIssueId
        ? { id: niche.linkedIssueId, identifier: issueIdentifier, status: issueStatus, title: issueTitle }
        : null,
    }));
  }

  async function listScores(companyId: string) {
    const rows = await db.select().from(searchfundScores).where(eq(searchfundScores.companyId, companyId));
    return rankScores(rows).map((row) => ({
      id: row.id,
      rank: row.rank,
      subniche: row.subniche,
      taxonomyId: row.taxonomyId,
      issue: row.issue,
      scoringStatus: row.scoringStatus,
      decisionScore: row.decisionScore,
      nicheSummary: row.nicheSummary,
      crossNicheSummary: row.crossNicheSummary,
      crossNicheComparison: row.crossNicheComparison,
      details: row.details,
      result: row.result,
      generatedAt: row.generatedAt,
      updatedAt: row.updatedAt,
    }));
  }

  /** The Scoring workbook's tabs, rebuilt from the stored score.py JSON. */
  async function scoringTables(companyId: string) {
    const scores = await listScores(companyId);
    return buildScoringTables(
      scores.map((s) => ({
        rank: s.rank,
        subniche: s.subniche,
        nicheSummary: (s.nicheSummary ?? {}) as Record<string, unknown>,
        crossNicheSummary: (s.crossNicheSummary ?? null) as Record<string, unknown> | null,
        crossNicheComparison: (s.crossNicheComparison ?? null) as Record<string, unknown> | null,
        details: (s.details ?? null) as Record<string, unknown> | null,
        result: (s.result ?? null) as Record<string, unknown> | null,
      })),
    );
  }

  // ---- Taxonomy_Master, queried in SQL: search (trigram index), column filters (jsonb containment, GIN index), sort, pages.

  const numericPattern = NUMERIC_RE.source;

  function nicheWhere(companyId: string, query: TableQuery, skipColumn?: string) {
    const conds: SQL[] = [eq(searchfundNiches.companyId, companyId)];
    for (const [column, values] of Object.entries(query.filters)) {
      if (column === skipColumn || !values.length) continue;
      const any = values.map((v) => sql`${searchfundNiches.row} @> ${JSON.stringify({ [column]: v })}::jsonb`);
      conds.push(sql`(${sql.join(any, sql` OR `)})`);
    }
    if (query.q) conds.push(sql`${searchfundNiches.searchText} LIKE ${`%${escapeLike(query.q.toLowerCase())}%`}`);
    return and(...conds)!;
  }

  /** Column list (sheet order), each column's type from its values, and the run counters. */
  async function nicheColumns(companyId: string) {
    const [first] = await db
      .select({ fields: searchfundNiches.fields })
      .from(searchfundNiches)
      .where(eq(searchfundNiches.companyId, companyId))
      .orderBy(searchfundNiches.sheetRow)
      .limit(1);
    const stats = await db.execute<{
      key: string; filled: number; distinct: number; avg_length: number | null; numeric: boolean; max: number | null; min: number | null; all_percent: boolean;
    }>(sql`
      SELECT e.key,
        count(*) FILTER (WHERE e.value <> '')::int AS filled,
        count(DISTINCT e.value) FILTER (WHERE e.value <> '')::int AS distinct,
        avg(length(e.value)) FILTER (WHERE e.value <> '')::float AS avg_length,
        COALESCE(bool_and(e.value ~ ${numericPattern}) FILTER (WHERE e.value <> ''), false) AS numeric,
        max(CASE WHEN e.value ~ ${numericPattern} THEN regexp_replace(e.value, '[,$%[:space:]]', '', 'g')::float END) AS max,
        min(CASE WHEN e.value ~ ${numericPattern} THEN regexp_replace(e.value, '[,$%[:space:]]', '', 'g')::float END) AS min,
        COALESCE(bool_and(e.value LIKE '%\\%') FILTER (WHERE e.value <> ''), false) AS all_percent
      FROM ${searchfundNiches}, jsonb_each_text(${searchfundNiches.row}) e
      WHERE ${searchfundNiches.companyId} = ${companyId}
      GROUP BY e.key`);
    const [counts] = await db
      .select({
        total: sql<number>`count(*)::int`,
        finished: sql<number>`count(*) FILTER (WHERE ${searchfundNiches.runStatus} LIKE 'Finished%')::int`,
        running: sql<number>`count(*) FILTER (WHERE ${searchfundNiches.linkedIssueId} IS NOT NULL AND COALESCE(${searchfundNiches.runStatus}, '') NOT LIKE 'Finished%')::int`,
      })
      .from(searchfundNiches)
      .where(eq(searchfundNiches.companyId, companyId));
    const byKey = new Map(Array.from(stats).map((r) => [r.key, r]));
    const order = [TAXONOMY_ID_COLUMN, ...(first?.fields ?? []).map((f) => f.header)];
    for (const key of byKey.keys()) if (!order.includes(key)) order.push(key);
    const total = counts?.total ?? 0;
    const model = await scoringModel(companyId);
    const columns: TableColumn[] = [...new Set(order)].filter((key) => byKey.has(key)).map((key) => {
      const st = byKey.get(key)!;
      const column: TableColumn = {
        key,
        label: key,
        type: inferColumnType(key, {
          rows: total, filled: st.filled, distinct: st.distinct, avgLength: st.avg_length ?? 0,
          numeric: st.numeric, max: st.max, allPercent: st.all_percent,
        }),
      };
      // The sheet's conditional formatting on Taxonomy_Master.
      if (key === COMPOSITE_COLUMN) {
        column.type = "number";
        if (st.min !== null && st.max !== null) column.scale = { min: st.min, max: st.max, colors: ["#ff0000", "#00ff00"] };
        if (model) {
          column.note = `Σ score × Scoring_Model weight: ${model.map((m) => `${m.dimension} ${Math.round(m.weight * 100)}%`).join(" + ")}`;
        }
      }
      if (key === "Gate Flag") column.highlight = GATE_FLAG_HIGHLIGHT;
      return column;
    });
    return {
      columns,
      stats: { total, finished: counts?.finished ?? 0, running: counts?.running ?? 0, notStarted: total - (counts?.finished ?? 0) - (counts?.running ?? 0) },
    };
  }

  /** One page of Taxonomy_Master rows. Default order is the sheet's row order. */
  async function queryNiches(companyId: string, query: TableQuery) {
    const where = nicheWhere(companyId, query);
    const order: SQL[] = [];
    if (query.sort) {
      const cell = sql`NULLIF(${searchfundNiches.row} ->> ${query.sort}, '')`;
      const dir = query.dir === "asc" ? sql`ASC` : sql`DESC`;
      order.push(sql`(CASE WHEN ${cell} ~ ${numericPattern} THEN regexp_replace(${cell}, '[,$%[:space:]]', '', 'g')::numeric END) ${dir} NULLS LAST`);
      order.push(sql`lower(${cell}) ${dir} NULLS LAST`);
    }
    order.push(sql`${searchfundNiches.sheetRow} ASC NULLS LAST`, sql`${searchfundNiches.taxonomyId} ASC`);
    const rows = await db
      .select({
        niche: searchfundNiches,
        issueIdentifier: issues.identifier,
        issueStatus: issues.status,
        issueTitle: issues.title,
        total: sql<number>`count(*) OVER ()::int`,
      })
      .from(searchfundNiches)
      .leftJoin(issues, eq(searchfundNiches.linkedIssueId, issues.id))
      .where(where)
      .orderBy(...order)
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    let total = rows[0]?.total ?? 0;
    if (!rows.length && query.page > 1) {
      const [c] = await db.select({ n: sql<number>`count(*)::int` }).from(searchfundNiches).where(where);
      total = c?.n ?? 0;
    }
    return {
      total,
      page: query.page,
      pageSize: query.pageSize,
      rows: rows.map(({ niche, issueIdentifier, issueStatus, issueTitle }) => ({
        id: niche.id,
        taxonomyId: niche.taxonomyId,
        shortName: niche.shortName,
        runStatus: niche.runStatus,
        row: niche.row,
        linkedIssue: niche.linkedIssueId
          ? { id: niche.linkedIssueId, identifier: issueIdentifier, status: issueStatus, title: issueTitle }
          : null,
      })),
    };
  }

  /** Distinct values of one Taxonomy_Master column, with counts, under every other active filter and the search. */
  async function nicheFacets(companyId: string, column: string, query: TableQuery): Promise<Facet[]> {
    const value = sql<string>`COALESCE(${searchfundNiches.row} ->> ${column}, '')`;
    const rows = await db
      .select({ value, count: sql<number>`count(*)::int` })
      .from(searchfundNiches)
      .where(nicheWhere(companyId, query, column))
      .groupBy(sql`1`)
      .limit(FACET_LIMIT);
    const { columns } = await nicheColumns(companyId);
    return sortFacets(rows, columns.find((c) => c.key === column)?.type ?? "text");
  }

  // ---- Scoring tables: built from the stored JSON, then searched/filtered/sorted/paged here.

  async function scoringOverview(companyId: string) {
    const tables = await scoringTables(companyId);
    return tables.map((t) => ({
      key: t.key,
      title: t.title,
      description: t.description,
      columns: t.columns,
      rowCount: t.rows.length,
      // The niche summary is small and feeds the stat cards and the chart.
      rows: t.key === "niche_summary" ? t.rows : [],
    }));
  }

  async function scoringTable(companyId: string, key: string) {
    const table = (await scoringTables(companyId)).find((t) => t.key === key);
    if (!table) throw notFound("Unknown scoring table");
    return table;
  }

  async function queryScoring(companyId: string, key: string, query: TableQuery) {
    const table = await scoringTable(companyId, key);
    return queryRows(table.columns, table.rows, query);
  }

  async function scoringFacets(companyId: string, key: string, column: string, query: TableQuery) {
    const table = await scoringTable(companyId, key);
    return facetRows(table.columns, table.rows, query, column);
  }

  /** Store one layer JSON for a run directly (backfill from exported layer files). */
  async function recordLayerDoc(companyId: string, input: { issue: unknown; layerIssue?: unknown; doc: unknown }) {
    const doc = isRecord(input.doc) ? input.doc : null;
    const layerId = doc && isRecord(doc.layer) ? str(doc.layer.id) : "";
    const runIssue = str(input.issue);
    if (!doc || !runIssue || !/^L[0-8]$/.test(layerId)) throw badRequest("issue and a layer doc with layer.id L0-L8 are required");
    const layerIssue = str(input.layerIssue) || null;
    await db
      .insert(searchfundLayerDocs)
      .values({ companyId, runIssue, layerId, layerIssue, doc, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [searchfundLayerDocs.companyId, searchfundLayerDocs.runIssue, searchfundLayerDocs.layerId],
        set: { layerIssue, doc, updatedAt: new Date() },
      });
    return { issue: runIssue, layer: layerId };
  }

  async function listFiles(companyId: string) {
    const rows = await db
      .select()
      .from(searchfundFiles)
      .where(eq(searchfundFiles.companyId, companyId))
      .orderBy(desc(searchfundFiles.updatedAt));
    const taxonomyIds = [...new Set(rows.map((row) => row.taxonomyId).filter((id): id is string => !!id))];
    const names = taxonomyIds.length
      ? await db
        .select({ taxonomyId: searchfundNiches.taxonomyId, shortName: searchfundNiches.shortName })
        .from(searchfundNiches)
        .where(and(eq(searchfundNiches.companyId, companyId), inArray(searchfundNiches.taxonomyId, taxonomyIds)))
      : [];
    const nameById = new Map(names.map((n) => [n.taxonomyId, n.shortName]));
    return rows.map((row) => ({
      id: row.id,
      filename: row.filename,
      issue: row.issue,
      taxonomyId: row.taxonomyId,
      nicheName: row.taxonomyId ? nameById.get(row.taxonomyId) ?? null : null,
      contentType: row.contentType,
      byteSize: row.byteSize,
      updatedAt: row.updatedAt,
    }));
  }

  async function getFile(companyId: string, fileId: string) {
    const row = await db
      .select()
      .from(searchfundFiles)
      .where(and(eq(searchfundFiles.companyId, companyId), eq(searchfundFiles.id, fileId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("File not found");
    return row;
  }

  async function resolveRoutineId(companyId: string, configured: string | null) {
    if (configured) return configured;
    const routine = await db
      .select({ id: routines.id })
      .from(routines)
      .where(and(
        eq(routines.companyId, companyId),
        ne(routines.status, "archived"),
        ilike(routines.title, "%Full Qualification%"),
      ))
      .orderBy(desc(routines.updatedAt))
      .then((rows) => rows[0] ?? null);
    if (!routine) throw conflict("No SearchFund qualification routine found (set SEARCHFUND_ROUTINE_ID)");
    return routine.id;
  }

  /** Same variables the dashboard sheet's ▶ checkbox sends to the routine trigger. */
  async function runNiche(
    companyId: string,
    nicheId: string,
    opts: { routineId: string | null; userId: string | null; idempotencyKey?: string | null },
  ) {
    const niche = await db
      .select()
      .from(searchfundNiches)
      .where(and(eq(searchfundNiches.companyId, companyId), eq(searchfundNiches.id, nicheId)))
      .then((rows) => rows[0] ?? null);
    if (!niche) throw notFound("Niche not found");
    const routineId = await resolveRoutineId(companyId, opts.routineId);
    // Fire through the routine's webhook trigger, the same one the dashboard sheet's ▶ checkbox calls.
    const webhook = await db
      .select({ id: routineTriggers.id })
      .from(routineTriggers)
      .where(and(eq(routineTriggers.routineId, routineId), eq(routineTriggers.kind, "webhook"), eq(routineTriggers.enabled, true)))
      .then((rows) => rows[0] ?? null);
    const run = await routinesSvc.runRoutine(
      routineId,
      {
        // The run is recorded against the webhook trigger; the caller is already authenticated, so no signature is needed.
        source: (webhook ? "webhook" : "api") as "api",
        triggerId: webhook?.id,
        variables: {
          micro_niche: niche.shortName,
          taxonomy_id: niche.taxonomyId,
          niche_context: nicheContext(niche.fields),
        },
        payload: { source: "agent-studio-searchfund", taxonomy_id: niche.taxonomyId },
        idempotencyKey: opts.idempotencyKey ?? null,
      },
      { userId: opts.userId, agentId: null },
    );
    const linkedIssueId = run.linkedIssueId ?? null;
    const issue = linkedIssueId
      ? await db.select({ identifier: issues.identifier }).from(issues).where(eq(issues.id, linkedIssueId)).then((rows) => rows[0] ?? null)
      : null;
    const stamp = new Date().toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
    const runStatus = `Research started · ${stamp}`;
    // Keep the row's own columns in step, so the table, filters and search show the new run straight away.
    const patch: Record<string, string> = { "Agent Research Status": "In Progress", "Run Status": runStatus };
    if (issue?.identifier) patch["Research Task"] = issue.identifier;
    const fields = niche.fields.map((f) => (f.header in patch ? { ...f, value: patch[f.header] } : f));
    await db
      .update(searchfundNiches)
      .set({
        researchStatus: "In Progress",
        runStatus,
        fields,
        ...nicheRow({ taxonomyId: niche.taxonomyId, fields }),
        linkedIssueId: linkedIssueId ?? niche.linkedIssueId,
        lastRoutineRunId: run.id,
        updatedAt: new Date(),
      })
      .where(eq(searchfundNiches.id, niche.id));
    return { routineRunId: run.id, status: run.status, linkedIssueId, issueIdentifier: issue?.identifier ?? null, via: webhook ? "webhook" : "api" };
  }

  return { companyExists, syncTaxonomy, syncSheet, listWorkbooks, getSheet, harvestRun, harvestByIdentifier, harvestAll, listLayerDocs, recordLayerDoc, scoringTables, scoringOverview, queryScoring, scoringFacets, nicheColumns, queryNiches, nicheFacets, recomputeComposites, scoringModel, getScoringModel, saveScoringModel, resetScoringModel, listRuns, recordScore, recordDetails, recordFile, listNiches, listScores, listFiles, getFile, runNiche };
}
