import { pgTable, uuid, text, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import { boardApiKeys } from "./board_api_keys.js";

/**
 * One OAuth 2.0 authorization (Authorization Code + PKCE) a user granted to a
 * desktop client such as Turia. It carries the one-time code until it is
 * exchanged, then the refresh token and the company-scoped board key that is
 * the current access token.
 */
export const oauthGrants = pgTable(
  "oauth_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    companyIds: jsonb("company_ids").$type<string[]>().notNull(),
    codeHash: text("code_hash"),
    codeExpiresAt: timestamp("code_expires_at", { withTimezone: true }),
    codeUsedAt: timestamp("code_used_at", { withTimezone: true }),
    refreshTokenHash: text("refresh_token_hash"),
    boardApiKeyId: uuid("board_api_key_id").references(() => boardApiKeys.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    codeHashIdx: index("oauth_grants_code_hash_idx").on(table.codeHash),
    refreshTokenHashIdx: index("oauth_grants_refresh_token_hash_idx").on(table.refreshTokenHash),
    userIdx: index("oauth_grants_user_idx").on(table.userId),
  }),
);
