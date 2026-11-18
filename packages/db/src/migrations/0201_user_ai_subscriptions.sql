CREATE TABLE IF NOT EXISTS "user_ai_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "provider" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "method" text NOT NULL,
  "credential_encrypted" text NOT NULL,
  "account_label" text,
  "last_error" text,
  "last_used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_ai_subscriptions_user_provider_uq" ON "user_ai_subscriptions" USING btree ("user_id","provider");--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "subscription_owner_user_id" text;
