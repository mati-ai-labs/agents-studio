import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { companyConnectors } from "./company_connectors.js";
import { slackChannelRoutes } from "./slack_channel_routes.js";

/**
 * slack_thread_bindings — durable binding from a Slack root thread to a
 * Paperclip issue.
 *
 * Invariants:
 *  - Exactly one Paperclip issue may bind to a (workspace, channel, thread_ts).
 *  - Exactly one Slack thread may bind to a Paperclip issue.
 *  - The Slack root event ID is unique so we can idempotently recover after
 *    a duplicate retry.
 *
 * Deleting or disabling the upstream channel route does NOT delete bindings.
 * Existing threads remain durable; delivery stops only when the connector is
 * disconnected or invalid.
 */
export const slackThreadBindings = pgTable(
  "slack_thread_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => companyConnectors.id, { onDelete: "restrict" }),
    channelRouteId: uuid("channel_route_id").references(() => slackChannelRoutes.id, {
      onDelete: "set null",
    }),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    channelId: text("channel_id").notNull(),
    channelName: text("channel_name").notNull(),
    threadTs: text("thread_ts").notNull(),
    rootEventId: text("root_event_id").notNull(),
    rootUserId: text("root_user_id"),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceChannelThreadUq: uniqueIndex("slack_thread_bindings_workspace_channel_thread_uq").on(
      table.workspaceId,
      table.channelId,
      table.threadTs,
    ),
    issueUq: uniqueIndex("slack_thread_bindings_issue_uq").on(table.issueId),
    rootEventUq: uniqueIndex("slack_thread_bindings_root_event_uq").on(table.rootEventId),
    companyCreatedIdx: index("slack_thread_bindings_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
    connectorIdx: index("slack_thread_bindings_connector_idx").on(table.connectorId),
    // Lookup binding for a reply by (workspace, channel, thread).
    threadLookupIdx: index("slack_thread_bindings_thread_lookup_idx").on(
      table.workspaceId,
      table.channelId,
      table.threadTs,
    ),
    companyIssueIdx: index("slack_thread_bindings_company_issue_idx").on(
      table.companyId,
      table.issueId,
    ),
  }),
);

export type SlackThreadBinding = typeof slackThreadBindings.$inferSelect;
export type NewSlackThreadBinding = typeof slackThreadBindings.$inferInsert;