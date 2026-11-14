import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  GuardrailPolicyAction,
  GuardrailPolicyKind,
  GuardrailPolicyScopeType,
  GuardrailPolicySeverity,
  GuardrailPolicyStage,
} from "@paperclipai/shared";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const guardrailPolicies = pgTable(
  "guardrail_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    scopeType: text("scope_type").$type<GuardrailPolicyScopeType>().notNull().default("company"),
    scopeId: uuid("scope_id"),
    stage: text("stage").$type<GuardrailPolicyStage>().notNull(),
    name: text("name").notNull(),
    description: text("description"),
    kind: text("kind").$type<GuardrailPolicyKind>().notNull(),
    matcher: jsonb("matcher").$type<Record<string, unknown>>().notNull().default({}),
    action: text("action").$type<GuardrailPolicyAction>().notNull().default("redact"),
    severity: text("severity").$type<GuardrailPolicySeverity>().notNull().default("medium"),
    enabled: boolean("enabled").notNull().default(true),
    version: integer("version").notNull().default(1),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyScopeIdx: index("guardrail_policies_company_scope_idx").on(
      table.companyId,
      table.scopeType,
      table.scopeId,
    ),
    companyStageEnabledIdx: index("guardrail_policies_company_stage_enabled_idx").on(
      table.companyId,
      table.stage,
      table.enabled,
    ),
    companyNameUq: uniqueIndex("guardrail_policies_company_name_uq").on(table.companyId, table.name),
    scopeTypeCheck: check(
      "guardrail_policies_scope_type_check",
      sql`${table.scopeType} in ('company', 'agent', 'project', 'goal')`,
    ),
    scopeIdCheck: check(
      "guardrail_policies_scope_id_check",
      sql`(
        ${table.scopeType} = 'company' and ${table.scopeId} is null
      ) or (
        ${table.scopeType} in ('agent', 'project', 'goal') and ${table.scopeId} is not null
      )`,
    ),
    stageCheck: check(
      "guardrail_policies_stage_check",
      sql`${table.stage} in ('input', 'output', 'action')`,
    ),
    kindCheck: check(
      "guardrail_policies_kind_check",
      sql`${table.kind} in ('pii', 'secret', 'restricted_action', 'regex', 'allowlist', 'rule')`,
    ),
    actionCheck: check(
      "guardrail_policies_action_check",
      sql`${table.action} in ('allow', 'redact', 'block', 'require_approval')`,
    ),
    severityCheck: check(
      "guardrail_policies_severity_check",
      sql`${table.severity} in ('info', 'medium', 'high', 'critical')`,
    ),
    versionCheck: check("guardrail_policies_version_check", sql`${table.version} >= 1`),
  }),
);

export type GuardrailPolicyRecord = typeof guardrailPolicies.$inferSelect;
export type GuardrailPolicyInsert = typeof guardrailPolicies.$inferInsert;
