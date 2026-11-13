CREATE TABLE "eval_results" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "scenario_id" text NOT NULL,
  "scenario_version" text DEFAULT '1' NOT NULL,
  "bundle_id" text NOT NULL,
  "bundle" jsonb NOT NULL,
  "status" text NOT NULL,
  "score" real NOT NULL,
  "checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "cost_cents" real DEFAULT 0 NOT NULL,
  "input_tokens" real DEFAULT 0 NOT NULL,
  "output_tokens" real DEFAULT 0 NOT NULL,
  "cached_input_tokens" real DEFAULT 0 NOT NULL,
  "heartbeat_run_id" uuid,
  "observed_policy_fires" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "policy_labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "error" text,
  "evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "eval_results_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE INDEX "eval_results_company_evaluated_idx" ON "eval_results" USING btree ("company_id","evaluated_at");--> statement-breakpoint
CREATE INDEX "eval_results_company_scenario_idx" ON "eval_results" USING btree ("company_id","scenario_id");--> statement-breakpoint
CREATE INDEX "eval_results_company_bundle_idx" ON "eval_results" USING btree ("company_id","bundle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_results_scenario_bundle_evaluated_uq" ON "eval_results" USING btree ("company_id","scenario_id","bundle_id","evaluated_at");
