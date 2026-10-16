ALTER TABLE "searchfund_niches" ADD COLUMN "row" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "searchfund_niches" ADD COLUMN "search_text" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "searchfund_niches" n SET
  "row" = COALESCE((SELECT jsonb_object_agg(f->>'header', COALESCE(f->>'value', '')) FROM jsonb_array_elements(n."fields") f WHERE COALESCE(f->>'header', '') <> ''), '{}'::jsonb)
    || jsonb_build_object('Taxonomy ID', n."taxonomy_id"),
  "search_text" = lower(n."taxonomy_id" || ' ' || COALESCE((SELECT string_agg(f->>'value', ' ') FROM jsonb_array_elements(n."fields") f), ''));--> statement-breakpoint
CREATE INDEX "searchfund_niches_row_gin" ON "searchfund_niches" USING gin ("row" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "searchfund_niches_search_trgm" ON "searchfund_niches" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "searchfund_niches_company_sheet_row_idx" ON "searchfund_niches" USING btree ("company_id", "sheet_row");
