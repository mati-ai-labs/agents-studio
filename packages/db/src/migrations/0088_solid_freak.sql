CREATE TABLE "preview_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"runtime_service_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_accessed_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "preview_leases_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "preview_leases" ADD CONSTRAINT "preview_leases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "preview_leases" ADD CONSTRAINT "preview_leases_runtime_service_id_workspace_runtime_services_id_fk" FOREIGN KEY ("runtime_service_id") REFERENCES "public"."workspace_runtime_services"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "preview_leases_company_status_idx" ON "preview_leases" USING btree ("company_id","status");
--> statement-breakpoint
CREATE INDEX "preview_leases_status_expires_idx" ON "preview_leases" USING btree ("status","expires_at");
--> statement-breakpoint
CREATE INDEX "preview_leases_runtime_service_idx" ON "preview_leases" USING btree ("runtime_service_id","status");
