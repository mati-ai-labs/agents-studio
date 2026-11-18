ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "subscription_provider" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "subscription_model" text;
