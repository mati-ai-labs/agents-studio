import { sql } from "drizzle-orm";
import type { IssueCommentAuthorType, IssueCommentMetadata, IssueCommentPresentation } from "@paperclipai/shared";
import { pgTable, uuid, text, timestamp, index, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const issueComments = pgTable(
  "issue_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    authorAgentId: uuid("author_agent_id").references(() => agents.id),
    authorUserId: text("author_user_id"),
    authorType: text("author_type").$type<IssueCommentAuthorType>(),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    presentation: jsonb("presentation").$type<IssueCommentPresentation | null>(),
    metadata: jsonb("metadata").$type<IssueCommentMetadata | null>(),
    externalSource: text("external_source"),
    externalId: text("external_id"),
    externalAuthorId: text("external_author_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueIdx: index("issue_comments_issue_idx").on(table.issueId),
    companyIdx: index("issue_comments_company_idx").on(table.companyId),
    companyIssueCreatedAtIdx: index("issue_comments_company_issue_created_at_idx").on(
      table.companyId,
      table.issueId,
      table.createdAt,
    ),
    companyAuthorIssueCreatedAtIdx: index("issue_comments_company_author_issue_created_at_idx").on(
      table.companyId,
      table.authorUserId,
      table.issueId,
      table.createdAt,
    ),
    bodySearchIdx: index("issue_comments_body_search_idx").using("gin", table.body.op("gin_trgm_ops")),
    // Idempotency for external ingest sources (e.g. Slack). Only when both
    // external_source and external_id are set do we treat the comment as
    // deduplicated.
    externalUq: uniqueIndex("issue_comments_external_uq")
      .on(table.companyId, table.externalSource, table.externalId)
      .where(sql`${table.externalSource} IS NOT NULL AND ${table.externalId} IS NOT NULL`),
    externalIdx: index("issue_comments_external_idx").on(
      table.companyId,
      table.externalSource,
      table.externalId,
    ),
  }),
);
