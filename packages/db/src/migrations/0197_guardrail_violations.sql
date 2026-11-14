CREATE TABLE IF NOT EXISTS "guardrail_violations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"policy_id" uuid,
	"policy_version" integer,
	"stage" text NOT NULL,
	"action_taken" text NOT NULL,
	"actor_agent_id" uuid,
	"heartbeat_run_id" uuid,
	"subject_kind" text NOT NULL,
	"subject_id" text,
	"matched_excerpt" text,
	"resolved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guardrail_violations_stage_check" CHECK ("stage" IN ('input', 'output', 'action')),
	CONSTRAINT "guardrail_violations_action_check" CHECK ("action_taken" IN ('redact', 'block', 'require_approval'))
);--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'guardrail_violations_company_id_companies_id_fk'
	) THEN
		ALTER TABLE "guardrail_violations" ADD CONSTRAINT "guardrail_violations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'guardrail_violations_policy_id_guardrail_policies_id_fk'
	) THEN
		ALTER TABLE "guardrail_violations" ADD CONSTRAINT "guardrail_violations_policy_id_guardrail_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."guardrail_policies"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'guardrail_violations_actor_agent_id_agents_id_fk'
	) THEN
		ALTER TABLE "guardrail_violations" ADD CONSTRAINT "guardrail_violations_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'guardrail_violations_heartbeat_run_id_heartbeat_runs_id_fk'
	) THEN
		ALTER TABLE "guardrail_violations" ADD CONSTRAINT "guardrail_violations_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guardrail_violations_company_created_idx" ON "guardrail_violations" USING btree ("company_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guardrail_violations_company_policy_idx" ON "guardrail_violations" USING btree ("company_id", "policy_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guardrail_violations_company_stage_idx" ON "guardrail_violations" USING btree ("company_id", "stage");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guardrail_violations_company_agent_idx" ON "guardrail_violations" USING btree ("company_id", "actor_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guardrail_violations_company_run_idx" ON "guardrail_violations" USING btree ("company_id", "heartbeat_run_id");
