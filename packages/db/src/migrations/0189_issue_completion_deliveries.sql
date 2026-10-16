ALTER TABLE "issues" ADD COLUMN "completion_destination" jsonb;--> statement-breakpoint
CREATE TABLE "issue_completion_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "issue_id" uuid NOT NULL,
  "source_activity_id" uuid NOT NULL,
  "completion_transition_key" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "destination" jsonb NOT NULL,
  "payload" jsonb NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_attempt_at" timestamp with time zone,
  "leased_at" timestamp with time zone,
  "lease_expires_at" timestamp with time zone,
  "lease_token" text,
  "delivered_at" timestamp with time zone,
  "provider_message_id" text,
  "last_error" text,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "issue_completion_deliveries_company_id_companies_id_fk"
    FOREIGN KEY ("company_id")
    REFERENCES "public"."companies"("id")
    ON DELETE cascade
    ON UPDATE no action,
  CONSTRAINT "issue_completion_deliveries_issue_id_issues_id_fk"
    FOREIGN KEY ("issue_id")
    REFERENCES "public"."issues"("id")
    ON DELETE cascade
    ON UPDATE no action,
  CONSTRAINT "issue_completion_deliveries_source_activity_id_activity_log_id_fk"
    FOREIGN KEY ("source_activity_id")
    REFERENCES "public"."activity_log"("id")
    ON DELETE cascade
    ON UPDATE no action
);--> statement-breakpoint
CREATE INDEX "issue_completion_deliveries_due_idx"
  ON "issue_completion_deliveries" USING btree ("status","next_attempt_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "issue_completion_deliveries_issue_created_idx"
  ON "issue_completion_deliveries" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_completion_deliveries_transition_uq"
  ON "issue_completion_deliveries" USING btree ("issue_id","completion_transition_key");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_completion_deliveries_source_activity_uq"
  ON "issue_completion_deliveries" USING btree ("source_activity_id");
