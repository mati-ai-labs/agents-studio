import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * A user's own Claude / Codex subscription credential. Strictly user-scoped:
 * runs only ever load the row whose user_id equals the issue's
 * subscription_owner_user_id, which can only be set by that user.
 */
export const userAiSubscriptions = pgTable(
  "user_ai_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    /** "claude" | "codex" */
    provider: text("provider").notNull(),
    /** "active" | "invalid" */
    status: text("status").notNull().default("active"),
    /** "setup_token" | "device_auth" | "auth_json" */
    method: text("method").notNull(),
    /** AES-256-GCM (server/src/lib/encryption.ts). Never returned by the API. */
    credentialEncrypted: text("credential_encrypted").notNull(),
    accountLabel: text("account_label"),
    lastError: text("last_error"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userProviderUq: uniqueIndex("user_ai_subscriptions_user_provider_uq").on(table.userId, table.provider),
  }),
);
