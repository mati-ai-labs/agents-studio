-- company_connectors shipped in the schema without a migration; idempotent so
-- environments where the table was created out-of-band are left untouched.
CREATE TABLE IF NOT EXISTS "company_connectors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action,
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
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_connectors_company_idx" ON "company_connectors" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_connectors_company_type_idx" ON "company_connectors" USING btree ("company_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_connectors_company_type_uq" ON "company_connectors" USING btree ("company_id","type");
