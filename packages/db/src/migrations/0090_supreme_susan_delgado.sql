CREATE TABLE IF NOT EXISTS "company_connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"credentials_encrypted" text,
	"display_name" text,
	"last_error" text,
	"connected_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_connectors_company_id_companies_id_fk') THEN
		ALTER TABLE "company_connectors" ADD CONSTRAINT "company_connectors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_connectors_company_idx" ON "company_connectors" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_connectors_company_type_idx" ON "company_connectors" USING btree ("company_id","type");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_connectors_company_type_uq" ON "company_connectors" USING btree ("company_id","type");
--> statement-breakpoint
CREATE TABLE "slack_channel_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"workspace_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"channel_name" text NOT NULL,
	"assignee_agent_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_event_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"api_app_id" text,
	"event_type" text NOT NULL,
	"channel_id" text,
	"thread_ts" text,
	"message_ts" text,
	"event_user_id" text,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processing_started_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"last_error" text,
	"company_id" uuid,
	"binding_id" uuid,
	"issue_id" uuid,
	"comment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_outbound_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"binding_id" uuid,
	"issue_id" uuid NOT NULL,
	"comment_id" uuid,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text,
	"payload" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processing_started_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"slack_message_ts" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_thread_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"channel_route_id" uuid,
	"issue_id" uuid NOT NULL,
	"workspace_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"channel_name" text NOT NULL,
	"thread_ts" text NOT NULL,
	"root_event_id" text NOT NULL,
	"root_user_id" text,
	"last_inbound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN "external_source" text;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN "external_author_id" text;--> statement-breakpoint
ALTER TABLE "slack_channel_routes" ADD CONSTRAINT "slack_channel_routes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_channel_routes" ADD CONSTRAINT "slack_channel_routes_connector_id_company_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."company_connectors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_channel_routes" ADD CONSTRAINT "slack_channel_routes_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_event_deliveries" ADD CONSTRAINT "slack_event_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_event_deliveries" ADD CONSTRAINT "slack_event_deliveries_binding_id_slack_thread_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."slack_thread_bindings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_event_deliveries" ADD CONSTRAINT "slack_event_deliveries_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_event_deliveries" ADD CONSTRAINT "slack_event_deliveries_comment_id_issue_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_outbound_deliveries" ADD CONSTRAINT "slack_outbound_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_outbound_deliveries" ADD CONSTRAINT "slack_outbound_deliveries_connector_id_company_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."company_connectors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_outbound_deliveries" ADD CONSTRAINT "slack_outbound_deliveries_binding_id_slack_thread_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."slack_thread_bindings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_outbound_deliveries" ADD CONSTRAINT "slack_outbound_deliveries_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_outbound_deliveries" ADD CONSTRAINT "slack_outbound_deliveries_comment_id_issue_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_thread_bindings" ADD CONSTRAINT "slack_thread_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_thread_bindings" ADD CONSTRAINT "slack_thread_bindings_connector_id_company_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."company_connectors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_thread_bindings" ADD CONSTRAINT "slack_thread_bindings_channel_route_id_slack_channel_routes_id_fk" FOREIGN KEY ("channel_route_id") REFERENCES "public"."slack_channel_routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_thread_bindings" ADD CONSTRAINT "slack_thread_bindings_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_channel_routes_workspace_channel_uq" ON "slack_channel_routes" USING btree ("workspace_id","channel_id");--> statement-breakpoint
CREATE INDEX "slack_channel_routes_company_enabled_idx" ON "slack_channel_routes" USING btree ("company_id","enabled");--> statement-breakpoint
CREATE INDEX "slack_channel_routes_connector_idx" ON "slack_channel_routes" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "slack_channel_routes_company_assignee_idx" ON "slack_channel_routes" USING btree ("company_id","assignee_agent_id");--> statement-breakpoint
CREATE INDEX "slack_channel_routes_company_idx" ON "slack_channel_routes" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_event_deliveries_event_uq" ON "slack_event_deliveries" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_event_deliveries_message_uq" ON "slack_event_deliveries" USING btree ("workspace_id","channel_id","message_ts") WHERE "slack_event_deliveries"."channel_id" IS NOT NULL AND "slack_event_deliveries"."message_ts" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "slack_event_deliveries_status_next_attempt_idx" ON "slack_event_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "slack_event_deliveries_workspace_channel_thread_idx" ON "slack_event_deliveries" USING btree ("workspace_id","channel_id","thread_ts");--> statement-breakpoint
CREATE INDEX "slack_event_deliveries_company_created_idx" ON "slack_event_deliveries" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_outbound_deliveries_connector_dedupe_uq" ON "slack_outbound_deliveries" USING btree ("connector_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "slack_outbound_deliveries_status_next_attempt_idx" ON "slack_outbound_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "slack_outbound_deliveries_company_issue_created_idx" ON "slack_outbound_deliveries" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE INDEX "slack_outbound_deliveries_binding_idx" ON "slack_outbound_deliveries" USING btree ("binding_id");--> statement-breakpoint
CREATE INDEX "slack_outbound_deliveries_issue_idx" ON "slack_outbound_deliveries" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_thread_bindings_workspace_channel_thread_uq" ON "slack_thread_bindings" USING btree ("workspace_id","channel_id","thread_ts");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_thread_bindings_issue_uq" ON "slack_thread_bindings" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_thread_bindings_root_event_uq" ON "slack_thread_bindings" USING btree ("root_event_id");--> statement-breakpoint
CREATE INDEX "slack_thread_bindings_company_created_idx" ON "slack_thread_bindings" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "slack_thread_bindings_connector_idx" ON "slack_thread_bindings" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "slack_thread_bindings_thread_lookup_idx" ON "slack_thread_bindings" USING btree ("workspace_id","channel_id","thread_ts");--> statement-breakpoint
CREATE INDEX "slack_thread_bindings_company_issue_idx" ON "slack_thread_bindings" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_comments_external_uq" ON "issue_comments" USING btree ("company_id","external_source","external_id") WHERE "issue_comments"."external_source" IS NOT NULL AND "issue_comments"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "issue_comments_external_idx" ON "issue_comments" USING btree ("company_id","external_source","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issues_slack_thread_origin_uq" ON "issues" USING btree ("company_id","origin_kind","origin_id") WHERE "issues"."origin_kind" = 'slack_thread' and "issues"."origin_id" is not null;
CREATE TABLE IF NOT EXISTS "company_connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"credentials_encrypted" text,
	"display_name" text,
	"last_error" text,
	"connected_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_connectors_company_id_companies_id_fk') THEN
		ALTER TABLE "company_connectors" ADD CONSTRAINT "company_connectors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_connectors_company_idx" ON "company_connectors" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_connectors_company_type_idx" ON "company_connectors" USING btree ("company_id","type");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_connectors_company_type_uq" ON "company_connectors" USING btree ("company_id","type");
--> statement-breakpoint
