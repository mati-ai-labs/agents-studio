import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Supported connector types.
 */
export type ConnectorType = "google_workspace" | "notion" | "linear" | "jira" | "github" | "aws" | "hostinger" | "surge";

/**
 * Connector connection status.
 */
export type ConnectorStatus = "disconnected" | "connecting" | "connected" | "error";

/**
 * `company_connectors` table — stores OAuth/credential state for external
 * integrations that agents can use as MCP tools.
 *
 * Each company can have at most one connector of each type.
 * Credentials are stored encrypted in `credentials_encrypted` as JSON.
 *
 * @see MCP connector spec §connectors
 */
export const companyConnectors = pgTable(
  "company_connectors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    type: text("type").$type<ConnectorType>().notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").$type<ConnectorStatus>().notNull().default("disconnected"),
    /** Encrypted JSON containing access_token, refresh_token, expiry, etc. */
    credentialsEncrypted: text("credentials_encrypted"),
    /** Human-readable label for the connection, e.g. "jane@company.com" */
    displayName: text("display_name"),
    /** Error message if status is "error" */
    lastError: text("last_error"),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_connectors_company_idx").on(table.companyId),
    companyTypeIdx: index("company_connectors_company_type_idx").on(table.companyId, table.type),
    companyTypeUq: uniqueIndex("company_connectors_company_type_uq").on(
      table.companyId,
      table.type,
    ),
  }),
);
