import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { workspaceRuntimeServices } from "./workspace_runtime_services.js";

export const previewLeases = pgTable(
  "preview_leases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    runtimeServiceId: uuid("runtime_service_id")
      .notNull()
      .references(() => workspaceRuntimeServices.id, { onDelete: "cascade" }),
    slug: text("slug").notNull().unique(),
    status: text("status").notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("preview_leases_company_status_idx").on(table.companyId, table.status),
    expiryIdx: index("preview_leases_status_expires_idx").on(table.status, table.expiresAt),
    runtimeServiceIdx: index("preview_leases_runtime_service_idx").on(table.runtimeServiceId, table.status),
  }),
);
