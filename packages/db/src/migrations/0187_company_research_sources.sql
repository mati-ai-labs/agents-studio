ALTER TABLE "companies" ADD COLUMN "website" text;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "important_links" jsonb DEFAULT '[]'::jsonb NOT NULL;
