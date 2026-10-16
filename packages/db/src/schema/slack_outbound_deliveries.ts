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
import { companyConnectors } from "./company_connectors.js";
import { slackThreadBindings } from "./slack_thread_bindings.js";

/**
 * slack_outbound_deliveries — durable Slack message queue. The Paperclip
 * ingress handlers, comment service, and completion flow all enqueue here
 * with stable dedupe keys; the worker drains the queue with retries.
 *
 * Slack posting is at-least-once. `client_msg_id` reduces duplicates, but
 * a crash after Slack accepts a message and before Paperclip commits `sent`
 * can still produce a duplicate. This is documented behaviour, not a
 * correctness invariant.
 */
export const slackOutboundDeliveries = pgTable(
  "slack_outbound_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => companyConnectors.id, { onDelete: "restrict" }),
    bindingId: uuid("binding_id").references(() => slackThreadBindings.id, {
      onDelete: "set null",
    }),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    commentId: uuid("comment_id").references(() => issueComments.id, { onDelete: "set null" }),
    kind: text("kind")
      .$type<"acknowledgement" | "progress" | "completion" | "error">()
      .notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    channelId: text("channel_id").notNull(),
    threadTs: text("thread_ts"),
    payload: jsonb("payload").$type<Record<string, unknown> | null>(),
    status: text("status")
      .$type<"pending" | "processing" | "sent" | "failed">()
      .notNull()
      .default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    slackMessageTs: text("slack_message_ts"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    connectorDedupeUq: uniqueIndex("slack_outbound_deliveries_connector_dedupe_uq").on(
      table.connectorId,
      table.dedupeKey,
    ),
    statusNextAttemptIdx: index("slack_outbound_deliveries_status_next_attempt_idx").on(
      table.status,
      table.nextAttemptAt,
    ),
    companyIssueCreatedIdx: index("slack_outbound_deliveries_company_issue_created_idx").on(
      table.companyId,
      table.issueId,
      table.createdAt,
    ),
    bindingIdx: index("slack_outbound_deliveries_binding_idx").on(table.bindingId),
    issueIdx: index("slack_outbound_deliveries_issue_idx").on(table.issueId),
  }),
);

export type SlackOutboundDelivery = typeof slackOutboundDeliveries.$inferSelect;
export type NewSlackOutboundDelivery = typeof slackOutboundDeliveries.$inferInsert;
export type SlackOutboundKind = "acknowledgement" | "progress" | "completion" | "error";
export type SlackOutboundStatus = "pending" | "processing" | "sent" | "failed";