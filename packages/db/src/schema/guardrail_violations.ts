import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  GuardrailPolicyAction,
  GuardrailPolicyStage,
  GuardrailViolationSubjectKind,
} from "@paperclipai/shared";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { guardrailPolicies } from "./guardrail_policies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * Append-only record of every guardrail decision that was not `allow`. A row
 * pins the policy version that produced it, so a violation can be explained
 * by the exact policy text that was in force when it fired.
 */
export const guardrailViolations = pgTable(
  "guardrail_violations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    policyId: uuid("policy_id").references(() => guardrailPolicies.id, { onDelete: "set null" }),
    policyVersion: integer("policy_version"),
    stage: text("stage").$type<GuardrailPolicyStage>().notNull(),
    actionTaken: text("action_taken").$type<GuardrailPolicyAction>().notNull(),
    actorAgentId: uuid("actor_agent_id").references(() => agents.id, { onDelete: "set null" }),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    subjectKind: text("subject_kind").$type<GuardrailViolationSubjectKind>().notNull(),
    subjectId: text("subject_id"),
    /** Already-redacted excerpt of what matched. Never stores raw subject text. */
    matchedExcerpt: text("matched_excerpt"),
    resolved: boolean("resolved").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("guardrail_violations_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
    companyPolicyIdx: index("guardrail_violations_company_policy_idx").on(
      table.companyId,
      table.policyId,
    ),
    companyStageIdx: index("guardrail_violations_company_stage_idx").on(table.companyId, table.stage),
    companyAgentIdx: index("guardrail_violations_company_agent_idx").on(
      table.companyId,
      table.actorAgentId,
    ),
    companyRunIdx: index("guardrail_violations_company_run_idx").on(
      table.companyId,
      table.heartbeatRunId,
    ),
    stageCheck: check(
      "guardrail_violations_stage_check",
      sql`${table.stage} in ('input', 'output', 'action')`,
    ),
    actionCheck: check(
      "guardrail_violations_action_check",
      sql`${table.actionTaken} in ('redact', 'block', 'require_approval')`,
    ),
  }),
);

export type GuardrailViolationRecord = typeof guardrailViolations.$inferSelect;
export type GuardrailViolationInsert = typeof guardrailViolations.$inferInsert;
