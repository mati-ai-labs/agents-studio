ALTER TABLE "routine_runs" ADD COLUMN "callback_issue_id" uuid;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_callback_issue_id_issues_id_fk"
  FOREIGN KEY ("callback_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routine_runs_callback_issue_idx" ON "routine_runs" USING btree ("callback_issue_id");--> statement-breakpoint
CREATE TABLE "routine_result_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "routine_run_id" uuid NOT NULL,
  "source_issue_id" uuid NOT NULL,
  "execution_issue_id" uuid NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_attempt_at" timestamp with time zone,
  "leased_at" timestamp with time zone,
  "lease_expires_at" timestamp with time zone,
  "lease_token" text,
  "delivered_at" timestamp with time zone,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "routine_result_deliveries_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "routine_result_deliveries_routine_run_id_routine_runs_id_fk"
    FOREIGN KEY ("routine_run_id") REFERENCES "public"."routine_runs"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "routine_result_deliveries_source_issue_id_issues_id_fk"
    FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "routine_result_deliveries_execution_issue_id_issues_id_fk"
    FOREIGN KEY ("execution_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX "routine_result_deliveries_routine_run_uq"
  ON "routine_result_deliveries" USING btree ("routine_run_id");--> statement-breakpoint
CREATE INDEX "routine_result_deliveries_due_idx"
  ON "routine_result_deliveries" USING btree ("status", "next_attempt_at", "lease_expires_at");--> statement-breakpoint
CREATE INDEX "routine_result_deliveries_source_issue_created_idx"
  ON "routine_result_deliveries" USING btree ("source_issue_id", "created_at");
