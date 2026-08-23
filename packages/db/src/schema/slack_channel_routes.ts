import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { companyConnectors } from "./company_connectors.js";

/**
 * slack_channel_routes — public-channel → assignee routing rules.
 *
 * Each row binds one (workspace_id, channel_id) to a single Paperclip agent
 * for a given company. The unique constraint on (workspace_id, channel_id)
 * is instance-wide so the same Slack channel cannot be routed into two
 * companies — channel ownership is a workspace-level concept, not a
 * company-level concept.
 *
 * Disabling a route or deleting the connector does not delete existing
 * `slack_thread_bindings`. Existing threads remain durable.
 */
export const slackChannelRoutes = pgTable(
  "slack_channel_routes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => companyConnectors.id, { onDelete: "restrict" }),
    workspaceId: text("workspace_id").notNull(),
    channelId: text("channel_id").notNull(),
    channelName: text("channel_name").notNull(),
    assigneeAgentId: uuid("assignee_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    enabled: boolean("enabled").notNull().default(true),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceChannelUq: uniqueIndex("slack_channel_routes_workspace_channel_uq")
      .on(table.workspaceId, table.channelId),
    companyEnabledIdx: index("slack_channel_routes_company_enabled_idx").on(
      table.companyId,
      table.enabled,
    ),
    connectorIdx: index("slack_channel_routes_connector_idx").on(table.connectorId),
    companyAssigneeIdx: index("slack_channel_routes_company_assignee_idx").on(
      table.companyId,
      table.assigneeAgentId,
    ),
    // Defense-in-depth: keep index on companyId alone for joins that ignore
    // enabled state. Drizzle generates a unique index + above indexes — add
    // this as a plain btree index for unrestricted company scans.
    companyIdx: index("slack_channel_routes_company_idx").on(table.companyId),
  }),
);

export type SlackChannelRoute = typeof slackChannelRoutes.$inferSelect;
export type NewSlackChannelRoute = typeof slackChannelRoutes.$inferInsert;