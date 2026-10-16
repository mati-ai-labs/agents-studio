import { pgTable, uuid, text, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { routineRuns } from "./routines.js";

export type RoutineResultDeliveryStatus = "pending" | "sending" | "sent" | "failed";

/**
 * A durable relay from a standalone routine execution issue back to the issue
 * that invoked its webhook. This deliberately does not create an issue-tree
 * relationship: routine execution must not trigger a parent/child handoff.
 */
export const routineResultDeliveries = pgTable(
  "routine_result_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    routineRunId: uuid("routine_run_id")
      .notNull()
      .references(() => routineRuns.id, { onDelete: "cascade" }),
    sourceIssueId: uuid("source_issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    executionIssueId: uuid("execution_issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    status: text("status").$type<RoutineResultDeliveryStatus>().notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    leasedAt: timestamp("leased_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    leaseToken: text("lease_token"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    routineRunUq: uniqueIndex("routine_result_deliveries_routine_run_uq").on(table.routineRunId),
    dueIdx: index("routine_result_deliveries_due_idx").on(
      table.status,
      table.nextAttemptAt,
      table.leaseExpiresAt,
    ),
    sourceIssueCreatedIdx: index("routine_result_deliveries_source_issue_created_idx").on(
      table.sourceIssueId,
      table.createdAt,
    ),
  }),
);
