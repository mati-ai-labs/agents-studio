import { pgTable, uuid, text, timestamp, jsonb, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import type { IssueCompletionDestination } from "@paperclipai/shared";
import { activityLog } from "./activity_log.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export type IssueCompletionDeliveryStatus =
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "superseded";

export const issueCompletionDeliveries = pgTable(
  "issue_completion_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    sourceActivityId: uuid("source_activity_id")
      .notNull()
      .references(() => activityLog.id, { onDelete: "cascade" }),
    completionTransitionKey: text("completion_transition_key").notNull(),
    status: text("status").$type<IssueCompletionDeliveryStatus>().notNull().default("pending"),
    destination: jsonb("destination").$type<IssueCompletionDestination>().notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    leasedAt: timestamp("leased_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    leaseToken: text("lease_token"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    providerMessageId: text("provider_message_id"),
    lastError: text("last_error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    dueIdx: index("issue_completion_deliveries_due_idx").on(
      table.status,
      table.nextAttemptAt,
      table.leaseExpiresAt,
    ),
    issueCreatedIdx: index("issue_completion_deliveries_issue_created_idx").on(
      table.issueId,
      table.createdAt,
    ),
    completionTransitionUq: uniqueIndex("issue_completion_deliveries_transition_uq").on(
      table.issueId,
      table.completionTransitionKey,
    ),
    sourceActivityUq: uniqueIndex("issue_completion_deliveries_source_activity_uq").on(
      table.sourceActivityId,
    ),
  }),
);
