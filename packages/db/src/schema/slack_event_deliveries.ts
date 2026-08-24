import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { issueComments } from "./issue_comments.js";
import { slackThreadBindings } from "./slack_thread_bindings.js";

/**
 * slack_event_deliveries — durable record of accepted Slack Events API
 * callbacks. Persisted before HTTP 200 is returned so duplicate retries
 * are deduplicated via the unique `(event_id)` index and the partial
 * unique `(workspace_id, channel_id, message_ts)` index that catches
 * the same Slack message arriving as both `app_mention` and
 * `message.channels`.
 */
export const slackEventDeliveries = pgTable(
  "slack_event_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: text("event_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    apiAppId: text("api_app_id"),
    eventType: text("event_type").notNull(),
    channelId: text("channel_id"),
    threadTs: text("thread_ts"),
    messageTs: text("message_ts"),
    eventUserId: text("event_user_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status")
      .$type<"pending" | "processing" | "succeeded" | "ignored" | "failed">()
      .notNull()
      .default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    lastError: text("last_error"),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    bindingId: uuid("binding_id").references(() => slackThreadBindings.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    commentId: uuid("comment_id").references(() => issueComments.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    eventUq: uniqueIndex("slack_event_deliveries_event_uq").on(table.eventId),
    // Partial unique index catches the same Slack message arriving as both
    // `app_mention` and `message.channels`.
    messageUq: uniqueIndex("slack_event_deliveries_message_uq")
      .on(table.workspaceId, table.channelId, table.messageTs)
      .where(sql`${table.channelId} IS NOT NULL AND ${table.messageTs} IS NOT NULL`),
    statusNextAttemptIdx: index("slack_event_deliveries_status_next_attempt_idx").on(
      table.status,
      table.nextAttemptAt,
    ),
    workspaceChannelThreadIdx: index("slack_event_deliveries_workspace_channel_thread_idx").on(
      table.workspaceId,
      table.channelId,
      table.threadTs,
    ),
    companyCreatedIdx: index("slack_event_deliveries_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
  }),
);

export type SlackEventDelivery = typeof slackEventDeliveries.$inferSelect;
export type NewSlackEventDelivery = typeof slackEventDeliveries.$inferInsert;