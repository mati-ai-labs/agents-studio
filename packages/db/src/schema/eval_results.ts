import type { EvalBundle, EvalCheckDetail, EvalResultStatus } from "@paperclipai/shared";
import { index, jsonb, pgTable, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * One row per (scenario, bundle, run) evaluation.
 *
 * Scores are stored alongside the bundle that produced them and the per-check
 * detail, so a score stays comparable across agent configurations and over
 * time: the bundle definition travels with the result instead of being inferred
 * from whatever the agent config happened to be at read time.
 */
export const evalResults = pgTable(
  "eval_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** Stable scenario identifier, e.g. `core.assignment_pickup`. */
    scenarioId: text("scenario_id").notNull(),
    /** Scenario definition version, so results can be compared across edits. */
    scenarioVersion: text("scenario_version").notNull().default("1"),
    /** Identifier of the bundle that was evaluated. */
    bundleId: text("bundle_id").notNull(),
    /** Full bundle definition (adapter + model + prompts + skills + flags). */
    bundle: jsonb("bundle").$type<EvalBundle>().notNull(),
    status: text("status").$type<EvalResultStatus>().notNull(),
    /** 0..1 score across the scored checks. */
    score: real("score").notNull(),
    /** Per-check pass/fail detail that produced the score. */
    checks: jsonb("checks").$type<EvalCheckDetail[]>().notNull().default([]),
    /** Cost and token usage for the evaluated run, from `cost_events`. */
    costCents: real("cost_cents").notNull().default(0),
    inputTokens: real("input_tokens").notNull().default(0),
    outputTokens: real("output_tokens").notNull().default(0),
    cachedInputTokens: real("cached_input_tokens").notNull().default(0),
    /** The heartbeat run that was evaluated, when one was produced. */
    heartbeatRunId: uuid("heartbeat_run_id"),
    /** Policy ids observed firing during the run, for precision/recall. */
    observedPolicyFires: jsonb("observed_policy_fires").$type<string[]>().notNull().default([]),
    /** Policy expectations declared by the scenario. */
    policyLabels: jsonb("policy_labels").$type<
      Array<{ policyId: string; expectation: "fire" | "not_fire" }>
    >().notNull().default([]),
    error: text("error"),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("eval_results_company_evaluated_idx").on(table.companyId, table.evaluatedAt),
    index("eval_results_company_scenario_idx").on(table.companyId, table.scenarioId),
    index("eval_results_company_bundle_idx").on(table.companyId, table.bundleId),
    uniqueIndex("eval_results_scenario_bundle_evaluated_uq").on(
      table.companyId,
      table.scenarioId,
      table.bundleId,
      table.evaluatedAt,
    ),
  ],
);
