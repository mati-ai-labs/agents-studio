CREATE TABLE "slack_polls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "issue_id" uuid NOT NULL,
  "created_by_agent_id" uuid,
  "channel_id" text NOT NULL,
  "channel_name" text NOT NULL,
  "message_ts" text,
  "thread_ts" text,
  "question" text NOT NULL,
  "options" jsonb NOT NULL,
  "multi_select" boolean DEFAULT false NOT NULL,
  "votes" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "closes_at" timestamp with time zone,
  "closed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "slack_polls_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "slack_polls_issue_id_issues_id_fk"
    FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "slack_polls_created_by_agent_id_agents_id_fk"
    FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action
);--> statement-breakpoint
CREATE INDEX "slack_polls_company_issue_idx" ON "slack_polls" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "slack_polls_channel_message_idx" ON "slack_polls" USING btree ("channel_id","message_ts");
