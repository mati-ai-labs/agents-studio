import { pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

// Company dashboards: self-contained HTML apps that agents build outside the repo and publish
// into Agent Studio. Studio stores every published version, renders the current one in a
// sandboxed iframe, and gives each dashboard its own JSON record store.

export const companyDashboards = pgTable(
  "company_dashboards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** draft (no version yet) | active | archived */
    status: text("status").notNull().default("draft"),
    currentVersion: integer("current_version"),
    /** Lower-cased viewer emails; null = every board member of the company. */
    allowedEmails: jsonb("allowed_emails").$type<string[] | null>(),
    /** Routines the page may run through the bridge (set by a board member, never the page). */
    allowedRoutineIds: jsonb("allowed_routine_ids").$type<string[]>().notNull().default([]),
    /** Agent that builds and changes this dashboard. */
    builderAgentId: uuid("builder_agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** sha256 of the ingest token external systems use to write records. */
    ingestTokenHash: text("ingest_token_hash"),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySlugUq: uniqueIndex("company_dashboards_company_slug_uq").on(table.companyId, table.slug),
  }),
);

export const companyDashboardVersions = pgTable(
  "company_dashboard_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dashboardId: uuid("dashboard_id").notNull().references(() => companyDashboards.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    html: text("html").notNull(),
    note: text("note"),
    sha256: text("sha256").notNull(),
    byteSize: integer("byte_size").notNull(),
    issueId: uuid("issue_id"),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    dashboardVersionUq: uniqueIndex("company_dashboard_versions_dashboard_version_uq").on(table.dashboardId, table.version),
  }),
);

export const companyDashboardRecords = pgTable(
  "company_dashboard_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dashboardId: uuid("dashboard_id").notNull().references(() => companyDashboards.id, { onDelete: "cascade" }),
    collection: text("collection").notNull(),
    key: text("key").notNull(),
    data: jsonb("data").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    dashboardCollectionKeyUq: uniqueIndex("company_dashboard_records_uq").on(table.dashboardId, table.collection, table.key),
    dashboardCollectionIdx: index("company_dashboard_records_collection_idx").on(table.dashboardId, table.collection, table.updatedAt),
  }),
);

/** Change / build requests filed against a dashboard (each one is an issue for the builder agent). */
export const companyDashboardRequests = pgTable(
  "company_dashboard_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dashboardId: uuid("dashboard_id").notNull().references(() => companyDashboards.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull(),
    kind: text("kind").notNull(), // build | change
    request: text("request").notNull(),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    dashboardIdx: index("company_dashboard_requests_dashboard_idx").on(table.dashboardId, table.createdAt),
  }),
);

/** Files a dashboard offers for download (reports, workbooks). Same name replaces the file. */
export const companyDashboardFiles = pgTable(
  "company_dashboard_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dashboardId: uuid("dashboard_id").notNull().references(() => companyDashboards.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    objectKey: text("object_key").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    dashboardNameUq: uniqueIndex("company_dashboard_files_dashboard_name_uq").on(table.dashboardId, table.name),
  }),
);
