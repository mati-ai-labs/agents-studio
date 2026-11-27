CREATE TABLE IF NOT EXISTS "company_dashboards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_version" integer,
	"allowed_emails" jsonb,
	"allowed_routine_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"builder_agent_id" uuid,
	"ingest_token_hash" text,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_dashboards" ADD CONSTRAINT "company_dashboards_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_dashboards" ADD CONSTRAINT "company_dashboards_builder_agent_id_agents_id_fk" FOREIGN KEY ("builder_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_dashboards_company_slug_uq" ON "company_dashboards" USING btree ("company_id","slug");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_dashboard_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dashboard_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"html" text NOT NULL,
	"note" text,
	"sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"issue_id" uuid,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_dashboard_versions" ADD CONSTRAINT "company_dashboard_versions_dashboard_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."company_dashboards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_dashboard_versions_dashboard_version_uq" ON "company_dashboard_versions" USING btree ("dashboard_id","version");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_dashboard_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dashboard_id" uuid NOT NULL,
	"collection" text NOT NULL,
	"key" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_dashboard_records" ADD CONSTRAINT "company_dashboard_records_dashboard_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."company_dashboards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_dashboard_records_uq" ON "company_dashboard_records" USING btree ("dashboard_id","collection","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_dashboard_records_collection_idx" ON "company_dashboard_records" USING btree ("dashboard_id","collection","updated_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_dashboard_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dashboard_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"request" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_dashboard_requests" ADD CONSTRAINT "company_dashboard_requests_dashboard_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."company_dashboards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_dashboard_requests_dashboard_idx" ON "company_dashboard_requests" USING btree ("dashboard_id","created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_dashboard_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dashboard_id" uuid NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"object_key" text NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_dashboard_files" ADD CONSTRAINT "company_dashboard_files_dashboard_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."company_dashboards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_dashboard_files_dashboard_name_uq" ON "company_dashboard_files" USING btree ("dashboard_id","name");
