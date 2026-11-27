ALTER TABLE "board_api_keys" ADD COLUMN IF NOT EXISTS "company_ids" jsonb;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"company_ids" jsonb NOT NULL,
	"code_hash" text,
	"code_expires_at" timestamp with time zone,
	"code_used_at" timestamp with time zone,
	"refresh_token_hash" text,
	"board_api_key_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_board_api_key_id_board_api_keys_id_fk" FOREIGN KEY ("board_api_key_id") REFERENCES "public"."board_api_keys"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_grants_code_hash_idx" ON "oauth_grants" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_grants_refresh_token_hash_idx" ON "oauth_grants" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_grants_user_idx" ON "oauth_grants" USING btree ("user_id");
