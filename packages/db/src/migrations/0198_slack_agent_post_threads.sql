ALTER TABLE "slack_thread_bindings" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'slack_mention' NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "slack_thread_bindings_issue_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "slack_thread_bindings_issue_uq" ON "slack_thread_bindings" USING btree ("issue_id") WHERE "slack_thread_bindings"."source" = 'slack_mention';
