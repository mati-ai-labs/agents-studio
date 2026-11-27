import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { boardApiKeys, companies, oauthGrants } from "@paperclipai/db";
import { badRequest } from "../errors.js";
import { boardAuthService, createBoardApiToken, hashBearerToken, tokenHashesMatch } from "./board-auth.js";

/**
 * OAuth 2.0 Authorization Code + PKCE for native desktop clients (RFC 8252).
 *
 * The client opens the Agent Studio consent page in the user's browser with a
 * loopback redirect (http://127.0.0.1:<port>/...). The signed-in user picks the
 * companies to grant; Agent Studio redirects back with a one-time code that the
 * client exchanges (with its PKCE verifier) for a company-scoped board key and
 * a rotating refresh token.
 */

export interface OAuthClient {
  id: string;
  name: string;
  description: string;
}

/** Registered public clients. They have no secret; PKCE + loopback redirect protect the flow. */
export const OAUTH_CLIENTS: Record<string, OAuthClient> = {
  turia: {
    id: "turia",
    name: "Turia",
    description: "Turia desktop assistant: hand tasks to your agents and track their progress.",
  },
};

export const OAUTH_CODE_TTL_MS = 5 * 60 * 1000;
export const OAUTH_ACCESS_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Error that the token endpoint reports in the RFC 6749 §5.2 shape. */
export class OAuthError extends Error {
  constructor(
    readonly code: "invalid_request" | "invalid_client" | "invalid_grant" | "unsupported_grant_type",
    message: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  responseType: string;
  state?: string | null;
}

const PKCE_VALUE = /^[A-Za-z0-9\-._~]{43,128}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

function sha256Base64Url(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

function createOAuthSecret(prefix: string) {
  return `${prefix}${randomBytes(32).toString("hex")}`;
}

export function getOAuthClient(clientId: string): OAuthClient {
  const client = OAUTH_CLIENTS[clientId.trim()];
  if (!client) throw badRequest("Unknown OAuth client");
  return client;
}

/** Only loopback http redirects with an explicit port are allowed (RFC 8252 §7.3). */
export function isAllowedRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "http:" &&
    LOOPBACK_HOSTS.has(url.hostname) &&
    url.port !== "" &&
    !url.username &&
    !url.password &&
    !url.hash
  );
}

/** Validates the authorize request parameters; throws a 400 the consent page shows. */
export function validateAuthorizeRequest(input: AuthorizeRequest): OAuthClient {
  const client = getOAuthClient(input.clientId);
  if (input.responseType !== "code") throw badRequest("response_type must be code");
  if (!isAllowedRedirectUri(input.redirectUri)) {
    throw badRequest("redirect_uri must be a loopback http URL with a port");
  }
  if (input.codeChallengeMethod !== "S256") throw badRequest("code_challenge_method must be S256");
  if (!PKCE_VALUE.test(input.codeChallenge)) throw badRequest("code_challenge is invalid");
  return client;
}

export function redirectWithParams(redirectUri: string, params: Record<string, string | null | undefined>) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

export function oauthService(db: Db) {
  const boardAuth = boardAuthService(db);

  /** The companies a user may grant: active memberships, with names and role. */
  async function grantableCompanies(userId: string) {
    const access = await boardAuth.resolveBoardAccess(userId);
    if (!access.user || access.memberships.length === 0) return [];
    const rows = await db
      .select({ id: companies.id, name: companies.name, issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(inArray(companies.id, access.memberships.map((row) => row.companyId)));
    const byId = new Map(rows.map((row) => [row.id, row]));
    return access.memberships
      .map((membership) => {
        const company = byId.get(membership.companyId);
        if (!company) return null;
        return {
          id: company.id,
          name: company.name,
          issuePrefix: company.issuePrefix,
          membershipRole: membership.membershipRole ?? null,
          // Viewers cannot create issues, so granting them would be useless.
          canGrant: membership.membershipRole !== "viewer",
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async function companySummaries(companyIds: string[]) {
    if (companyIds.length === 0) return [];
    const rows = await db
      .select({ id: companies.id, name: companies.name, issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(inArray(companies.id, companyIds));
    return rows.sort((left, right) => left.name.localeCompare(right.name));
  }

  /** Records the user's consent and returns the one-time code to send back to the client. */
  async function approve(input: AuthorizeRequest & { userId: string; companyIds: string[] }) {
    validateAuthorizeRequest(input);
    const requested = Array.from(new Set(input.companyIds.map((id) => id.trim()).filter(Boolean)));
    if (requested.length === 0) throw badRequest("Choose at least one company");
    const grantable = new Set(
      (await grantableCompanies(input.userId)).filter((row) => row.canGrant).map((row) => row.id),
    );
    const denied = requested.filter((id) => !grantable.has(id));
    if (denied.length > 0) throw badRequest("You cannot grant access to one or more selected companies");

    const code = createOAuthSecret("pcp_oauth_code_");
    await db.insert(oauthGrants).values({
      userId: input.userId,
      clientId: input.clientId.trim(),
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      companyIds: requested,
      codeHash: hashBearerToken(code),
      codeExpiresAt: new Date(Date.now() + OAUTH_CODE_TTL_MS),
    });
    return code;
  }

  async function issueTokens(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    grant: typeof oauthGrants.$inferSelect,
  ) {
    const client = OAUTH_CLIENTS[grant.clientId];
    const accessToken = createBoardApiToken();
    const refreshToken = createOAuthSecret("pcp_oauth_refresh_");
    const expiresAt = new Date(Date.now() + OAUTH_ACCESS_TOKEN_TTL_MS);
    const key = await tx
      .insert(boardApiKeys)
      .values({
        userId: grant.userId,
        name: `${client?.name ?? grant.clientId} (OAuth)`,
        keyHash: hashBearerToken(accessToken),
        expiresAt,
        companyIds: grant.companyIds,
      })
      .returning()
      .then((rows) => rows[0]);
    await tx
      .update(oauthGrants)
      .set({ boardApiKeyId: key.id, refreshTokenHash: hashBearerToken(refreshToken), updatedAt: new Date() })
      .where(eq(oauthGrants.id, grant.id));
    return { accessToken, refreshToken, expiresAt };
  }

  async function revokeGrantRow(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    grant: typeof oauthGrants.$inferSelect,
  ) {
    const now = new Date();
    await tx.update(oauthGrants).set({ revokedAt: now, updatedAt: now }).where(eq(oauthGrants.id, grant.id));
    if (grant.boardApiKeyId) {
      await tx
        .update(boardApiKeys)
        .set({ revokedAt: now })
        .where(and(eq(boardApiKeys.id, grant.boardApiKeyId), isNull(boardApiKeys.revokedAt)));
    }
  }

  async function tokenResponse(
    grant: typeof oauthGrants.$inferSelect,
    tokens: { accessToken: string; refreshToken: string; expiresAt: Date },
  ) {
    const [access, granted] = await Promise.all([
      boardAuth.resolveBoardAccess(grant.userId),
      companySummaries(grant.companyIds),
    ]);
    return {
      access_token: tokens.accessToken,
      token_type: "Bearer" as const,
      expires_in: Math.floor((tokens.expiresAt.getTime() - Date.now()) / 1000),
      refresh_token: tokens.refreshToken,
      scope: "issues agents",
      user: access.user ? { id: access.user.id, name: access.user.name, email: access.user.email } : null,
      companies: granted,
    };
  }

  /** authorization_code grant: verifies the code and PKCE verifier, then issues tokens. */
  async function exchangeCode(input: {
    code: string;
    codeVerifier: string;
    clientId: string;
    redirectUri: string;
  }) {
    if (!OAUTH_CLIENTS[input.clientId]) throw new OAuthError("invalid_client", "Unknown OAuth client");
    if (!input.code) throw new OAuthError("invalid_request", "code is required");
    if (!PKCE_VALUE.test(input.codeVerifier)) throw new OAuthError("invalid_request", "code_verifier is invalid");
    const codeHash = hashBearerToken(input.code);

    const result = await db.transaction(async (tx) => {
      const grant = await tx
        .select()
        .from(oauthGrants)
        .where(eq(oauthGrants.codeHash, codeHash))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!grant || !grant.codeHash || !tokenHashesMatch(grant.codeHash, codeHash)) {
        throw new OAuthError("invalid_grant", "Authorization code is invalid");
      }
      if (grant.codeUsedAt) {
        // A replayed code means it leaked: revoke everything it produced (RFC 6749 §4.1.2).
        await revokeGrantRow(tx, grant);
        return { error: new OAuthError("invalid_grant", "Authorization code was already used") };
      }
      if (grant.revokedAt) throw new OAuthError("invalid_grant", "Authorization was revoked");
      if (!grant.codeExpiresAt || grant.codeExpiresAt.getTime() <= Date.now()) {
        throw new OAuthError("invalid_grant", "Authorization code expired");
      }
      if (grant.clientId !== input.clientId || grant.redirectUri !== input.redirectUri) {
        throw new OAuthError("invalid_grant", "client_id or redirect_uri does not match the authorization");
      }
      if (sha256Base64Url(input.codeVerifier) !== grant.codeChallenge) {
        throw new OAuthError("invalid_grant", "PKCE verification failed");
      }
      await tx
        .update(oauthGrants)
        .set({ codeUsedAt: new Date(), updatedAt: new Date() })
        .where(eq(oauthGrants.id, grant.id));
      return { grant, tokens: await issueTokens(tx, grant) };
    });
    if ("error" in result) throw result.error;
    return tokenResponse(result.grant, result.tokens);
  }

  /** refresh_token grant: rotates both tokens. A grant whose key the user revoked is dead. */
  async function refresh(input: { refreshToken: string; clientId: string }) {
    if (!OAUTH_CLIENTS[input.clientId]) throw new OAuthError("invalid_client", "Unknown OAuth client");
    if (!input.refreshToken) throw new OAuthError("invalid_request", "refresh_token is required");
    const refreshHash = hashBearerToken(input.refreshToken);

    const result = await db.transaction(async (tx) => {
      const grant = await tx
        .select()
        .from(oauthGrants)
        .where(eq(oauthGrants.refreshTokenHash, refreshHash))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!grant || grant.revokedAt || grant.clientId !== input.clientId) {
        throw new OAuthError("invalid_grant", "Refresh token is invalid");
      }
      if (grant.boardApiKeyId) {
        const current = await tx
          .select({ revokedAt: boardApiKeys.revokedAt })
          .from(boardApiKeys)
          .where(eq(boardApiKeys.id, grant.boardApiKeyId))
          .then((rows) => rows[0] ?? null);
        // We only revoke keys on rotation after re-pointing the grant, so a
        // revoked current key means the user revoked this app in Agent Studio.
        if (current?.revokedAt) {
          await revokeGrantRow(tx, grant);
          return { error: new OAuthError("invalid_grant", "Access was revoked in Agent Studio") };
        }
        await tx
          .update(boardApiKeys)
          .set({ revokedAt: new Date() })
          .where(eq(boardApiKeys.id, grant.boardApiKeyId));
      }
      return { grant, tokens: await issueTokens(tx, grant) };
    });
    if ("error" in result) throw result.error;
    return tokenResponse(result.grant, result.tokens);
  }

  /** RFC 7009 revocation by access or refresh token. Unknown tokens are not an error. */
  async function revoke(token: string) {
    const tokenHash = hashBearerToken(token.trim());
    await db.transaction(async (tx) => {
      let grant = await tx
        .select()
        .from(oauthGrants)
        .where(eq(oauthGrants.refreshTokenHash, tokenHash))
        .then((rows) => rows[0] ?? null);
      if (!grant) {
        const key = await tx
          .select({ id: boardApiKeys.id })
          .from(boardApiKeys)
          .where(eq(boardApiKeys.keyHash, tokenHash))
          .then((rows) => rows[0] ?? null);
        if (key) {
          grant = await tx
            .select()
            .from(oauthGrants)
            .where(eq(oauthGrants.boardApiKeyId, key.id))
            .then((rows) => rows[0] ?? null);
        }
      }
      if (grant && !grant.revokedAt) await revokeGrantRow(tx, grant);
    });
  }

  /** Grants a user has given, for listing or revoking from Agent Studio. */
  async function listGrants(userId: string) {
    const rows = await db
      .select()
      .from(oauthGrants)
      .where(and(eq(oauthGrants.userId, userId), isNull(oauthGrants.revokedAt), sql`${oauthGrants.codeUsedAt} is not null`));
    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        clientId: row.clientId,
        clientName: OAUTH_CLIENTS[row.clientId]?.name ?? row.clientId,
        companies: await companySummaries(row.companyIds),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    );
  }

  async function revokeGrantForUser(grantId: string, userId: string) {
    return db.transaction(async (tx) => {
      const grant = await tx
        .select()
        .from(oauthGrants)
        .where(and(eq(oauthGrants.id, grantId), eq(oauthGrants.userId, userId)))
        .then((rows) => rows[0] ?? null);
      if (!grant) return false;
      if (!grant.revokedAt) await revokeGrantRow(tx, grant);
      return true;
    });
  }

  return {
    grantableCompanies,
    companySummaries,
    approve,
    exchangeCode,
    refresh,
    revoke,
    listGrants,
    revokeGrantForUser,
  };
}
