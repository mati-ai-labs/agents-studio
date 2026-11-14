CREATE TABLE IF NOT EXISTS "guardrail_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope_type" text DEFAULT 'company' NOT NULL,
	"scope_id" uuid,
	"stage" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" text NOT NULL,
	"matcher" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"action" text DEFAULT 'redact' NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guardrail_policies_scope_type_check" CHECK ("scope_type" IN ('company', 'agent', 'project', 'goal')),
	CONSTRAINT "guardrail_policies_scope_id_check" CHECK (
		("scope_type" = 'company' AND "scope_id" IS NULL)
		OR ("scope_type" IN ('agent', 'project', 'goal') AND "scope_id" IS NOT NULL)
	),
	CONSTRAINT "guardrail_policies_stage_check" CHECK ("stage" IN ('input', 'output', 'action')),
	CONSTRAINT "guardrail_policies_kind_check" CHECK ("kind" IN ('pii', 'secret', 'restricted_action', 'regex', 'allowlist', 'rule')),
	CONSTRAINT "guardrail_policies_action_check" CHECK ("action" IN ('allow', 'redact', 'block', 'require_approval')),
	CONSTRAINT "guardrail_policies_severity_check" CHECK ("severity" IN ('info', 'medium', 'high', 'critical')),
	CONSTRAINT "guardrail_policies_version_check" CHECK ("version" >= 1)
);--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'guardrail_policies_company_id_companies_id_fk'
	) THEN
		ALTER TABLE "guardrail_policies" ADD CONSTRAINT "guardrail_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'guardrail_policies_created_by_agent_id_agents_id_fk'
	) THEN
		ALTER TABLE "guardrail_policies" ADD CONSTRAINT "guardrail_policies_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guardrail_policies_company_scope_idx" ON "guardrail_policies" USING btree ("company_id", "scope_type", "scope_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guardrail_policies_company_stage_enabled_idx" ON "guardrail_policies" USING btree ("company_id", "stage", "enabled");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "guardrail_policies_company_name_uq" ON "guardrail_policies" USING btree ("company_id", "name");
