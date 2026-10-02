CREATE TABLE "searchfund_niches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "taxonomy_id" text NOT NULL,
  "short_name" text NOT NULL,
  "fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "research_status" text,
  "run_status" text,
  "linked_issue_id" uuid,
  "last_routine_run_id" uuid,
  "sheet_row" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "searchfund_niches_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "searchfund_niches_linked_issue_id_issues_id_fk"
    FOREIGN KEY ("linked_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX "searchfund_niches_company_taxonomy_uq"
  ON "searchfund_niches" USING btree ("company_id", "taxonomy_id");--> statement-breakpoint
CREATE TABLE "searchfund_scores" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "subniche" text NOT NULL,
  "taxonomy_id" text,
  "issue" text,
  "scoring_status" text,
  "decision_score" real,
  "niche_summary" jsonb NOT NULL,
  "cross_niche_summary" jsonb,
  "cross_niche_comparison" jsonb,
  "details" jsonb,
  "result" jsonb,
  "generated_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "searchfund_scores_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX "searchfund_scores_company_subniche_uq"
  ON "searchfund_scores" USING btree ("company_id", "subniche");--> statement-breakpoint
CREATE INDEX "searchfund_scores_company_taxonomy_idx"
  ON "searchfund_scores" USING btree ("company_id", "taxonomy_id");--> statement-breakpoint
CREATE TABLE "searchfund_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "filename" text NOT NULL,
  "issue" text,
  "taxonomy_id" text,
  "object_key" text NOT NULL,
  "content_type" text NOT NULL,
  "byte_size" integer NOT NULL,
  "sha256" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "searchfund_files_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX "searchfund_files_company_filename_uq"
  ON "searchfund_files" USING btree ("company_id", "filename");
--> statement-breakpoint
CREATE TABLE "searchfund_sheets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "workbook" text NOT NULL,
  "tab" text NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "row_count" integer DEFAULT 0 NOT NULL,
  "col_count" integer DEFAULT 0 NOT NULL,
  "synced_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "searchfund_sheets_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX "searchfund_sheets_company_workbook_tab_uq"
  ON "searchfund_sheets" USING btree ("company_id", "workbook", "tab");
--> statement-breakpoint
CREATE TABLE "searchfund_layer_docs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "run_issue" text NOT NULL,
  "layer_id" text NOT NULL,
  "layer_issue" text,
  "doc" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "searchfund_layer_docs_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX "searchfund_layer_docs_company_run_layer_uq"
  ON "searchfund_layer_docs" USING btree ("company_id", "run_issue", "layer_id");
