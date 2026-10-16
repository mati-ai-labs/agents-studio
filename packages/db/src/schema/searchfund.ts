import { pgTable, uuid, text, integer, real, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

// SearchFund dashboard: Agent Studio's own copy of what the Google Sheets pipeline writes.
// Rows arrive through POST /companies/:companyId/searchfund/ingest (forwarded by the Apps Scripts).

/** One row of the Taxonomy_Master dashboard sheet (a micro-niche that can be qualified). */
export const searchfundNiches = pgTable(
  "searchfund_niches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    taxonomyId: text("taxonomy_id").notNull(),
    shortName: text("short_name").notNull(),
    // Every sheet column, in sheet order: [{ header, value }].
    fields: jsonb("fields").$type<Array<{ header: string; value: string }>>().notNull().default([]),
    // The same row keyed by header (plus "Taxonomy ID"), for indexed column filters and sorting.
    row: jsonb("row").$type<Record<string, string>>().notNull().default({}),
    // Lower-cased text of every cell, for search.
    searchText: text("search_text").notNull().default(""),
    researchStatus: text("research_status"),
    runStatus: text("run_status"),
    linkedIssueId: uuid("linked_issue_id").references(() => issues.id, { onDelete: "set null" }),
    lastRoutineRunId: uuid("last_routine_run_id"),
    sheetRow: integer("sheet_row"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTaxonomyUq: uniqueIndex("searchfund_niches_company_taxonomy_uq").on(table.companyId, table.taxonomyId),
    rowGin: index("searchfund_niches_row_gin").using("gin", table.row.op("jsonb_path_ops")),
    searchTrgm: index("searchfund_niches_search_trgm").using("gin", table.searchText.op("gin_trgm_ops")),
    companySheetRowIdx: index("searchfund_niches_company_sheet_row_idx").on(table.companyId, table.sheetRow),
  }),
);

/** One scored niche: the score.py payload the sheet writer turns into scoring-sheet rows. */
export const searchfundScores = pgTable(
  "searchfund_scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    subniche: text("subniche").notNull(),
    taxonomyId: text("taxonomy_id"),
    issue: text("issue"),
    scoringStatus: text("scoring_status"),
    decisionScore: real("decision_score"),
    nicheSummary: jsonb("niche_summary").$type<Record<string, unknown>>().notNull(),
    crossNicheSummary: jsonb("cross_niche_summary").$type<Record<string, unknown> | null>(),
    crossNicheComparison: jsonb("cross_niche_comparison").$type<Record<string, unknown> | null>(),
    details: jsonb("details").$type<Record<string, unknown> | null>(),
    // The rest of score.py's result: gates, L7 overlays, L8 audit, integrity notes, gap queue, brief.
    result: jsonb("result").$type<Record<string, unknown> | null>(),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySubnicheUq: uniqueIndex("searchfund_scores_company_subniche_uq").on(table.companyId, table.subniche),
    companyTaxonomyIdx: index("searchfund_scores_company_taxonomy_idx").on(table.companyId, table.taxonomyId),
  }),
);

/** A Layer Data workbook (or any report file) for a run. Re-uploading the same filename replaces it. */
export const searchfundFiles = pgTable(
  "searchfund_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    issue: text("issue"),
    taxonomyId: text("taxonomy_id"),
    objectKey: text("object_key").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyFilenameUq: uniqueIndex("searchfund_files_company_filename_uq").on(table.companyId, table.filename),
  }),
);

/** Every tab of the two Google workbooks (dashboard + scoring), cell for cell as displayed in Sheets. */
export const searchfundSheets = pgTable(
  "searchfund_sheets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workbook: text("workbook").notNull(),
    tab: text("tab").notNull(),
    position: integer("position").notNull().default(0),
    rows: jsonb("rows").$type<string[][]>().notNull().default([]),
    rowCount: integer("row_count").notNull().default(0),
    colCount: integer("col_count").notNull().default(0),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyWorkbookTabUq: uniqueIndex("searchfund_sheets_company_workbook_tab_uq").on(table.companyId, table.workbook, table.tab),
  }),
);

/** One layer's research document (L0–L8 contract JSON) for a qualification run, collected from the run's tasks. */
export const searchfundLayerDocs = pgTable(
  "searchfund_layer_docs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    runIssue: text("run_issue").notNull(),
    layerId: text("layer_id").notNull(),
    layerIssue: text("layer_issue"),
    doc: jsonb("doc").$type<Record<string, unknown>>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRunLayerUq: uniqueIndex("searchfund_layer_docs_company_run_layer_uq").on(table.companyId, table.runIssue, table.layerId),
  }),
);
