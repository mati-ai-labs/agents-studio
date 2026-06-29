export function connectorsRoutes(db: Db): Router {
  return createConnectorsRouter({
    db,
    getBaseUrl: () =>
      process.env.PAPERCLIP_API_URL?.trim() ||
      process.env.PAPERCLIP_RUNTIME_API_URL?.trim() ||
      `http://127.0.0.1:${process.env.PORT ?? 3100}`,
  });
}

/**
 * @fileoverview Connector routes — OAuth and manual credential connectors.
 *
 * OAuth flow:
 *   1. POST /api/connectors/:type/connect  → redirect to OAuth provider
 *   2. GET  /api/connectors/:type/callback → exchange code for tokens, upsert connector
 *   3. DELETE /api/connectors/:type        → clear credentials, set disconnected
 *
 * Manual flow (non-OAuth):
 *   1. POST /api/connectors/:type/configure → save credential fields directly
 *
 * Additional routes:
 *   GET  /api/connectors          → list all connectors for the company
 *   GET  /api/connectors/:type    → get a single connector's status + config
 *
 * @see connector-registry.ts
 */

import { Router, urlencoded } from "express";
import type { Request, Response } from "express";
import crypto from "node:crypto";
import { companies, type Db } from "@paperclipai/db";
import { connectorRegistryService } from "../services/connector-registry.js";
import {
  assertAuthenticated,
  assertBoard,
  assertCompanyAccess,
} from "./authz.js";
import { badRequest } from "../errors.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ConnectorType = "google_workspace" | "notion" | "linear" | "jira" | "github" | "aws" | "hostinger" | "surge" | "meta_ads";
const GOOGLE_CONNECTOR_TYPE: ConnectorType = "google_workspace";
const META_ADS_CONNECTOR_TYPE: ConnectorType = "meta_ads";
const OAUTH_CONNECTOR_TYPES: ConnectorType[] = ["google_workspace", "notion", "linear", "meta_ads"];
const MANUAL_CONNECTOR_TYPES: ConnectorType[] = ["jira", "github", "aws", "hostinger", "surge"];
const ALL_CONNECTOR_TYPES: ConnectorType[] = [...OAUTH_CONNECTOR_TYPES, ...MANUAL_CONNECTOR_TYPES];
const GOOGLE_OAUTH_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
] as const;
const META_ADS_OAUTH_SCOPES = [
  "ads_management",
  "ads_read",
  "business_management",
] as const;

interface ConnectorOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

interface GoogleTokenResponse extends TokenResponse {
  id_token?: string;
}

function isMissingConnectorsTableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err.code === "42P01" || err.cause?.code === "42P01") return true;
  const text = `${err.message ?? ""} ${err.cause?.message ?? ""}`.toLowerCase();
  return text.includes("company_connectors") && text.includes("does not exist");
}

// ---------------------------------------------------------------------------
// OAuth Configurations
// ---------------------------------------------------------------------------

function getGoogleOAuthConfig(getBaseUrl: () => string): ConnectorOAuthConfig {
  const baseUrl = getBaseUrl();
  return {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    redirectUri: `${baseUrl}/api/connectors/google_workspace/callback`,
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [...GOOGLE_OAUTH_SCOPES],
  };
}

function getNotionOAuthConfig(getBaseUrl: () => string): ConnectorOAuthConfig {
  const baseUrl = getBaseUrl();
  return {
    clientId: process.env.NOTION_CLIENT_ID ?? "",
    clientSecret: process.env.NOTION_CLIENT_SECRET ?? "",
    redirectUri: `${baseUrl}/api/connectors/notion/callback`,
    authorizationUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    scopes: ["read_content", "update_content", "insert_content"],
  };
}

function getLinearOAuthConfig(getBaseUrl: () => string): ConnectorOAuthConfig {
  const baseUrl = getBaseUrl();
  return {
    clientId: process.env.LINEAR_CLIENT_ID ?? "",
    clientSecret: process.env.LINEAR_CLIENT_SECRET ?? "",
    redirectUri: `${baseUrl}/api/connectors/linear/callback`,
    authorizationUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    scopes: ["read", "write"],
  };
}

function getMetaAdsOAuthConfig(getBaseUrl: () => string): ConnectorOAuthConfig {
  const baseUrl = getBaseUrl();
  return {
    clientId: process.env.META_ADS_APP_ID ?? "",
    clientSecret: process.env.META_ADS_APP_SECRET ?? "",
    redirectUri: `${baseUrl}/api/connectors/meta_ads/callback`,
    authorizationUrl: "https://www.facebook.com/v18.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v18.0/oauth/access_token",
    scopes: [...META_ADS_OAUTH_SCOPES],
  };
}

function getOAuthConfig(type: ConnectorType, getBaseUrl: () => string): ConnectorOAuthConfig | null {
  switch (type) {
    case "google_workspace": return getGoogleOAuthConfig(getBaseUrl);
    case "notion": return getNotionOAuthConfig(getBaseUrl);
    case "linear": return getLinearOAuthConfig(getBaseUrl);
    case "meta_ads": return getMetaAdsOAuthConfig(getBaseUrl);
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

function buildAuthorizationUrl(
  type: ConnectorType,
  config: ConnectorOAuthConfig,
  state: string,
  codeChallenge: string,
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: config.scopes.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  if (type === GOOGLE_CONNECTOR_TYPE) {
    // Match Google OAuth redirect semantics used by the standalone connector flow.
    params.set("access_type", "offline");
    params.set("prompt", "consent");
    params.set("include_granted_scopes", "false");
  }
  if (type === META_ADS_CONNECTOR_TYPE) {
    // Meta's OAuth dialog does not accept PKCE params. Strip the PKCE
    // code_challenge / code_challenge_method — Meta authenticates by
    // app secret (passed in the token exchange) rather than verifier.
    params.delete("code_challenge");
    params.delete("code_challenge_method");
  }
  return `${config.authorizationUrl}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// State management (in-memory for OAuth flow — tied to session)
// ---------------------------------------------------------------------------

interface OAuthState {
  companyId: string;
  userId: string;
  type: ConnectorType;
  verifier: string;
  returnPath: string;
}

// Simple in-memory store keyed by state token
const oauthStateStore = new Map<string, OAuthState>();
const DEFAULT_CONNECTORS_RETURN_PATH = "/company/settings/connectors";

function normalizeReturnPath(input: string | null | undefined): string {
  const raw = (input ?? "").trim();
  if (!raw.startsWith("/")) return DEFAULT_CONNECTORS_RETURN_PATH;
  if (raw.startsWith("//")) return DEFAULT_CONNECTORS_RETURN_PATH;
  if (raw.startsWith("/connectors")) return raw;
  if (raw.includes("/company/settings/connectors")) return raw;
  return DEFAULT_CONNECTORS_RETURN_PATH;
}

function extractReturnPathFromReferrer(req: Request): string | null {
  const referer = req.header("referer")?.trim();
  if (!referer) return null;
  try {
    const parsed = new URL(referer);
    return `${parsed.pathname}${parsed.search || ""}`;
  } catch {
    return null;
  }
}

function resolveReturnPath(req: Request): string {
  const returnToQuery = req.query.returnTo;
  const returnTo = typeof returnToQuery === "string" ? returnToQuery : null;
  return normalizeReturnPath(returnTo ?? extractReturnPathFromReferrer(req));
}

function appendQueryParam(path: string, key: string, value: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function createOAuthState(
  companyId: string,
  userId: string,
  type: ConnectorType,
  returnPath: string,
): { state: string; oauthState: OAuthState } {
  const state = crypto.randomBytes(32).toString("base64url");
  const verifier = crypto.randomBytes(64).toString("base64url");
  const oauthState: OAuthState = { companyId, userId, type, verifier, returnPath };
  oauthStateStore.set(state, oauthState);
  // Auto-expire after 10 minutes
  setTimeout(() => oauthStateStore.delete(state), 10 * 60 * 1000);
  return { state, oauthState };
}

function clearOAuthStatesForCompanyAndType(companyId: string, userId: string, type: ConnectorType): void {
  for (const [state, entry] of oauthStateStore.entries()) {
    if (entry.companyId === companyId && entry.userId === userId && entry.type === type) {
      oauthStateStore.delete(state);
    }
  }
}

// ---------------------------------------------------------------------------
// Token exchange helpers
// ---------------------------------------------------------------------------

async function exchangeCodeForTokens(
  config: ConnectorOAuthConfig,
  code: string,
  codeVerifier: string,
): Promise<{ accessToken: string; refreshToken?: string; expiry?: number }> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: config.redirectUri,
    code_verifier: codeVerifier,
  });

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    logger.error({ error, status: response.status }, "OAuth token exchange failed");
    throw badRequest(`OAuth token exchange failed: ${response.status}`);
  }

  const data = (await response.json()) as TokenResponse | GoogleTokenResponse;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiry: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
  };
}

/**
 * Meta Ads uses a GET-based token endpoint (no PKCE, no separate refresh
 * token). The returned short-lived token is exchanged for a long-lived token
 * via `fb_exchange_token` immediately after the initial code exchange so the
 * connector stores the long-lived value.
 */
async function exchangeMetaAdsCodeForTokens(
  config: ConnectorOAuthConfig,
  code: string,
): Promise<{ accessToken: string; refreshToken?: string; expiry?: number }> {
  const params = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    code,
  });
  const url = `${config.tokenUrl}?${params.toString()}`;

  const response = await fetch(url, { method: "GET" });
  if (!response.ok) {
    const error = await response.text();
    logger.error({ error, status: response.status }, "Meta Ads token exchange failed");
    throw badRequest(`Meta Ads token exchange failed: ${response.status}`);
  }

  const shortLived = (await response.json()) as {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
  };
  const shortToken = typeof shortLived.access_token === "string" ? shortLived.access_token.trim() : "";
  if (!shortToken) {
    logger.error({ payload: shortLived }, "Meta Ads token exchange returned no access_token");
    throw badRequest("Meta Ads token exchange returned no access_token");
  }

  // Upgrade short-lived token to long-lived via fb_exchange_token. If the
  // upgrade fails we still persist the short-lived token so the user can
  // re-auth; the MCP resolver will detect the missing expiry and skip
  // injection until a fresh connect is performed.
  const exchangeParams = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    fb_exchange_token: shortToken,
  });
  const exchangeUrl = `${config.tokenUrl}?${exchangeParams.toString()}`;
  try {
    const exchangeResp = await fetch(exchangeUrl, { method: "GET" });
    if (exchangeResp.ok) {
      const longLived = (await exchangeResp.json()) as {
        access_token?: string;
        expires_in?: number;
      };
      const longToken = typeof longLived.access_token === "string" ? longLived.access_token.trim() : "";
      if (longToken) {
        const expiry = typeof longLived.expires_in === "number" && longLived.expires_in > 0
          ? Date.now() + longLived.expires_in * 1_000
          : Date.now() + 60 * 24 * 60 * 60 * 1_000; // ~60 days default
        return {
          accessToken: longToken,
          // Meta has no separate refresh_token; reuse the long-lived token so
          // the connector registry's credential shape stays consistent.
          refreshToken: longToken,
          expiry,
        };
      }
    } else {
      const errorBody = await exchangeResp.text().catch(() => "");
      logger.warn(
        { status: exchangeResp.status, body: errorBody.slice(0, 1_000) },
        "Meta Ads fb_exchange_token upgrade failed — persisting short-lived token",
      );
    }
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "Meta Ads fb_exchange_token upgrade threw — persisting short-lived token",
    );
  }

  return {
    accessToken: shortToken,
    refreshToken: shortToken,
    expiry: typeof shortLived.expires_in === "number" && shortLived.expires_in > 0
      ? Date.now() + shortLived.expires_in * 1_000
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export interface CreateConnectorsRouterDeps {
  db: Db;
  /** Returns the public-facing base URL for this deployment (used for OAuth redirect URIs). */
  getBaseUrl: () => string;
}

/** Returns the app's public base URL, used to construct OAuth redirect URIs. */
function resolveBaseUrl(): string {
  return (
    process.env.PAPERCLIP_API_URL?.trim() ||
    process.env.PAPERCLIP_RUNTIME_API_URL?.trim() ||
    `http://127.0.0.1:${process.env.PORT ?? 3100}`
  );
}

export function createConnectorsRouter(deps: CreateConnectorsRouterDeps): Router {
  const { db, getBaseUrl } = deps;
  const registry = connectorRegistryService(db);
  const router = Router();

  async function resolveCompanyId(req: Request): Promise<string> {
    const companyIdQuery = req.query.companyId;
    const requestedCompanyId =
      typeof companyIdQuery === "string" && companyIdQuery.trim().length > 0
        ? companyIdQuery.trim()
        : null;

    if (requestedCompanyId) {
      assertCompanyAccess(req, requestedCompanyId);
      return requestedCompanyId;
    }

    if (req.actor.type !== "board") {
      throw badRequest("Board access required");
    }

    if (req.actor.source !== "local_implicit") {
      const companyIds = req.actor.companyIds ?? [];
      if (companyIds.length === 1) {
        assertCompanyAccess(req, companyIds[0]);
        return companyIds[0];
      }
      if (companyIds.length > 1) {
        throw badRequest("companyId query parameter is required when multiple companies are accessible");
      }
      throw badRequest("No accessible company for current actor");
    }

    const fallbackCompany = await db
      .select({ id: companies.id })
      .from(companies)
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!fallbackCompany) {
      throw badRequest("No company found. Create a company first.");
    }
    assertCompanyAccess(req, fallbackCompany.id);
    return fallbackCompany.id;
  }

  function resolveActorUserId(req: Request): string {
    if (req.actor.type !== "board") {
      throw badRequest("Board access required");
    }
    const userId = req.actor.userId?.trim();
    if (!userId) {
      throw badRequest("Authenticated board user ID is required");
    }
    return userId;
  }

  async function handleOAuthCallback(req: Request, res: Response): Promise<void> {
    let callbackReturnPath = DEFAULT_CONNECTORS_RETURN_PATH;
    try {
      const callbackParams = {
        ...(req.query as Record<string, string>),
        ...((req.body ?? {}) as Record<string, string>),
      };
      const { code, state, error: oauthError } = callbackParams;

      if (oauthError) {
        logger.warn({ oauthError }, "OAuth error from provider");
        res.redirect(appendQueryParam(callbackReturnPath, "error", oauthError));
        return;
      }

      if (!state || !code) {
        res.redirect(appendQueryParam(callbackReturnPath, "error", "missing_params"));
        return;
      }

      const oauthState = oauthStateStore.get(state);
      if (!oauthState) {
        res.redirect(appendQueryParam(callbackReturnPath, "error", "invalid_state"));
        return;
      }
      oauthStateStore.delete(state);

      const { companyId, userId, type: connectorType, verifier, returnPath } = oauthState;
      callbackReturnPath = returnPath;
      const config = getOAuthConfig(connectorType as ConnectorType, getBaseUrl);

      if (!config) {
        res.redirect(appendQueryParam(returnPath, "error", "unknown_type"));
        return;
      }

      // Exchange code for tokens. Meta Ads uses a GET-based endpoint with no
      // PKCE; everything else uses the standard POST + code_verifier flow.
      const tokens = connectorType === META_ADS_CONNECTOR_TYPE
        ? await exchangeMetaAdsCodeForTokens(config, code)
        : await exchangeCodeForTokens(config, code, verifier);

      // Try to fetch user info for display name
      let displayName: string | undefined;
      try {
        if (connectorType === "google_workspace") {
          const resp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
            headers: { Authorization: `Bearer ${tokens.accessToken}` },
          });
          if (resp.ok) {
            const info = (await resp.json()) as { email?: string; name?: string };
            displayName = info.email ?? info.name ?? undefined;
          }
        }
      } catch {
        // non-fatal — continue without display name
      }

      // Persist connector with credentials
      await registry.upsert({
        companyId,
        userId,
        type: connectorType as ConnectorType,
        status: "connected",
        credentials: tokens,
        displayName,
      });

      logger.info({ companyId, type: connectorType }, "Connector connected successfully");
      res.redirect(appendQueryParam(returnPath, "connected", connectorType));
    } catch (err) {
      logger.error({ err }, "OAuth callback failed");
      res.redirect(appendQueryParam(callbackReturnPath, "error", "callback_failed"));
    }
  }

  // -------------------------------------------------------------------------
  // GET /api/connectors — list all connectors for the authenticated company
  // -------------------------------------------------------------------------
  router.get("/", async (req: Request, res: Response) => {
    assertAuthenticated(req);
    assertBoard(req);
    try {
      const companyId = await resolveCompanyId(req);
      const userId = resolveActorUserId(req);
      const connectors = await registry.listByCompanyForUser(companyId, userId);
      // Strip credentialsEncrypted from list response (security)
      const safe = connectors.map((c) => ({
        id: c.id,
        companyId: c.companyId,
        type: c.type,
        config: c.config,
        status: c.status,
        displayName: c.displayName,
        lastError: c.lastError,
        connectedAt: c.connectedAt,
        disconnectedAt: c.disconnectedAt,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      }));
      res.json({ connectors: safe });
    } catch (err) {
      if (isMissingConnectorsTableError(err)) {
        logger.warn({ err }, "Connector table missing; returning empty connector list");
        res.json({ connectors: [] });
        return;
      }
      logger.error({ err }, "Failed to list connectors");
      res.status(500).json({ error: "Internal error" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/connectors/:type — get connector status
  // -------------------------------------------------------------------------
  router.get("/:type", async (req: Request, res: Response) => {
    assertAuthenticated(req);
    assertBoard(req);
    try {
      const companyId = await resolveCompanyId(req);
      const userId = resolveActorUserId(req);
      const type = req.params.type as ConnectorType;
      if (!ALL_CONNECTOR_TYPES.includes(type)) {
        res.status(400).json({ error: "Invalid connector type" });
        return;
      }
      const connector = await registry.getByType(companyId, type, userId);
      if (!connector) {
        res.status(404).json({ error: "Connector not found" });
        return;
      }
      res.json({
        id: connector.id,
        type: connector.type,
        config: connector.config,
        status: connector.status,
        displayName: connector.displayName,
        lastError: connector.lastError,
        connectedAt: connector.connectedAt,
        disconnectedAt: connector.disconnectedAt,
        createdAt: connector.createdAt,
        updatedAt: connector.updatedAt,
      });
    } catch (err) {
      if (isMissingConnectorsTableError(err)) {
        logger.warn({ err }, "Connector table missing; connector state unavailable");
        res.status(503).json({ error: "Connectors storage is not initialized on this instance" });
        return;
      }
      logger.error({ err }, "Failed to get connector");
      res.status(500).json({ error: "Internal error" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/connectors/:type/credentials — get decrypted credentials for agents
  // Works for ALL connector types. Returns credentials decrypted server-side.
  // EC2 is self-hosted so credentials never leave our infrastructure.
  // -------------------------------------------------------------------------
  router.get("/:type/credentials", async (req: Request, res: Response) => {
    assertAuthenticated(req);
    assertBoard(req);
    try {
      const companyId = await resolveCompanyId(req);
      const userId = resolveActorUserId(req);
      const type = req.params.type as string;

      if (!type || type.trim().length === 0) {
        res.status(400).json({ error: "Connector type is required" });
        return;
      }

      const connector = await registry.getByType(companyId, type as ConnectorType, userId);
      if (!connector) {
        res.status(404).json({ error: "Connector not found" });
        return;
      }

      if (connector.status !== "connected") {
        res.status(409).json({ error: `Connector is ${connector.status}`, status: connector.status });
        return;
      }

      const credentials = await registry.getCredentialsAsync(companyId, type as ConnectorType, { userId });
      if (!credentials) {
        res.status(404).json({ error: "No credentials stored for this connector" });
        return;
      }

      // Return credentials formatted for the specific connector type
      if (type === "aws") {
        res.json({
          type: "aws",
          config: connector.config ?? {},
          credentials: {
            aws_access_key_id: credentials.accessToken,
            aws_secret_access_key: credentials.refreshToken ?? "",
            region: (connector.config?.region as string) ?? "us-east-1",
            bucket_name: connector.config?.bucket_name ?? null,
          },
        });
        return;
      }

      if (type === "hostinger") {
        res.json({
          type: "hostinger",
          config: connector.config ?? {},
          credentials: {
            api_token: credentials.accessToken,
          },
        });
        return;
      }

      if (type === "surge") {
        res.json({
          type: "surge",
          config: connector.config ?? {},
          credentials: {
            token: credentials.accessToken,
            default_domain: (connector.config?.default_domain as string) ?? null,
          },
        });
        return;
      }

      // Default: OAuth-style credentials (google_workspace, notion, linear, jira, github, etc.)
      res.json({
        type,
        config: connector.config ?? {},
        credentials: {
          access_token: credentials.accessToken,
          refresh_token: credentials.refreshToken,
          expiry: credentials.expiry,
        },
      });
    } catch (err) {
      if (isMissingConnectorsTableError(err)) {
        logger.warn({ err }, "Connector table missing; credentials unavailable");
        res.status(503).json({ error: "Connectors storage is not initialized on this instance" });
        return;
      }
      logger.error({ err }, "Failed to get connector credentials");
      res.status(500).json({ error: "Internal error" });
    }
  });


  // -------------------------------------------------------------------------
  // POST /api/connectors/:type/configure — save manual credentials
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // GET /:agentId/connector-credentials/:type
  //
  // Agent-runtime credentials endpoint. Agents (actor.type === "agent") call
  // this with their Bearer JWT to fetch decrypted credentials for connectors
  // configured for their company. Returns the SAME response shape as the
  // board-only endpoint, so the same skills work for both.
  //
  // Auth: assertCompanyAccess (works for board + agent). Agents are
  // constrained to their own agentId in the URL.
  // -------------------------------------------------------------------------
  router.get("/:agentId/connector-credentials/:type", async (req: Request, res: Response) => {
    assertAuthenticated(req);
    try {
      const requestedAgentId = typeof req.params.agentId === "string" ? req.params.agentId.trim() : "";
      const type = typeof req.params.type === "string" ? req.params.type : "";
      if (!requestedAgentId) {
        res.status(400).json({ error: "agentId is required" });
        return;
      }
      if (!type || type.trim().length === 0) {
        res.status(400).json({ error: "Connector type is required" });
        return;
      }
      if (!ALL_CONNECTOR_TYPES.includes(type as ConnectorType)) {
        res.status(400).json({
          error: "Invalid connector type. Allowed: " + ALL_CONNECTOR_TYPES.join(", "),
        });
        return;
      }

      // Agent can only fetch credentials for itself
      if (req.actor.type === "agent") {
        if (req.actor.agentId !== requestedAgentId) {
          res.status(403).json({ error: "Agent can only fetch its own credentials" });
          return;
        }
        if (!req.actor.companyId) {
          res.status(400).json({ error: "Agent is missing companyId in actor context" });
          return;
        }
        assertCompanyAccess(req, req.actor.companyId);
      } else if (req.actor.type === "board") {
        if (!req.query.companyId && Array.isArray(req.actor.companyIds) && req.actor.companyIds.length > 1) {
          res.status(400).json({ error: "companyId query parameter is required when multiple companies are accessible" });
          return;
        }
      }

      // Resolve companyId
      let companyId: string;
      if (req.actor.type === "agent") {
        companyId = req.actor.companyId as string;
      } else {
        companyId = await resolveCompanyId(req);
      }

      const connector = await registry.getByType(companyId, type as ConnectorType, null);
      if (!connector) {
        res.status(404).json({ error: "Connector not found" });
        return;
      }
      if (connector.status !== "connected") {
        res.status(409).json({ error: "Connector is " + connector.status, status: connector.status });
        return;
      }

      // For agents: fetch credentials using company-wide lookup (any
      // configured user's creds work since encryption is master-key based).
      const lookup = await registry.getCredentialsForAgentAsync(companyId, type as ConnectorType);
      if (!lookup) {
        res.status(404).json({ error: "No credentials stored for this connector" });
        return;
      }
      const { credentials, sourceUserId } = lookup;

      // AUDIT LOG
      logger.info(
        {
          actor: "agent",
          agentId: req.actor.type === "agent" ? req.actor.agentId : null,
          runId: req.actor.type === "agent" ? req.actor.runId : null,
          companyId,
          connectorType: type,
          sourceUserId,
          ts: new Date().toISOString(),
        },
        "connector_credentials_fetched_by_agent",
      );

      if (type === "aws") {
        res.json({
          type: "aws",
          config: connector.config ?? {},
          credentials: {
            aws_access_key_id: credentials.accessToken,
            aws_secret_access_key: credentials.refreshToken ?? "",
            region: (connector.config?.region as string) ?? "us-east-1",
            bucket_name: connector.config?.bucket_name ?? null,
          },
        });
        return;
      }
      if (type === "hostinger") {
        res.json({
          type: "hostinger",
          config: connector.config ?? {},
          credentials: { api_token: credentials.accessToken },
        });
        return;
      }
      if (type === "surge") {
        res.json({
          type: "surge",
          config: connector.config ?? {},
          credentials: {
            token: credentials.accessToken,
            default_domain: (connector.config?.default_domain as string) ?? null,
          },
        });
        return;
      }
      res.json({
        type,
        config: connector.config ?? {},
        credentials: {
          access_token: credentials.accessToken,
          refresh_token: credentials.refreshToken,
          expiry: credentials.expiry,
        },
      });
    } catch (err) {
      if (isMissingConnectorsTableError(err)) {
        logger.warn({ err }, "Connector table missing; agent credentials unavailable");
        res.status(503).json({ error: "Connectors storage is not initialized on this instance" });
        return;
      }
      logger.error({ err }, "Failed to fetch agent connector credentials");
      res.status(500).json({ error: "Internal error" });
    }
  });

  router.post("/:type/configure", async (req: Request, res: Response) => {
    assertAuthenticated(req);
    assertBoard(req);
    try {
      const companyId = await resolveCompanyId(req);
      const userId = resolveActorUserId(req);
      const type = req.params.type as ConnectorType;
      if (!MANUAL_CONNECTOR_TYPES.includes(type)) {
        res.status(400).json({ error: "This connector must be configured via OAuth connect flow" });
        return;
      }

      const payload = (req.body ?? {}) as Record<string, unknown>;
      if (type === "jira") {
        const baseUrl = readNonEmptyString(payload.baseUrl);
        const email = readNonEmptyString(payload.email);
        const accessToken = readNonEmptyString(payload.accessToken);
        if (!baseUrl || !email || !accessToken) {
          res.status(400).json({ error: "jira requires baseUrl, email, and accessToken" });
          return;
        }
        const existing = await registry.getByType(companyId, type, userId);
        const connector = await registry.upsert({
          companyId,
          userId,
          type,
          status: "connected",
          config: {
            ...(existing?.config ?? {}),
            baseUrl,
            email,
            mcpEnabled: true,
          },
          credentials: {
            accessToken,
          },
          displayName: email,
        });
        res.json({
          success: true,
          connector: {
            id: connector.id,
            companyId: connector.companyId,
            type: connector.type,
            config: connector.config,
            status: connector.status,
            displayName: connector.displayName,
            lastError: connector.lastError,
            connectedAt: connector.connectedAt,
            disconnectedAt: connector.disconnectedAt,
            createdAt: connector.createdAt,
            updatedAt: connector.updatedAt,
          },
        });
        return;
      }

      // AWS manual configuration
      if (type === "aws") {
        const awsAccessKeyId = readNonEmptyString(payload.awsAccessKeyId);
        const awsSecretAccessKey = readNonEmptyString(payload.awsSecretAccessKey);
        const region = readNonEmptyString(payload.region) ?? "us-east-1";
        const bucketName = readNonEmptyString(payload.bucketName);
        if (!awsAccessKeyId || !awsSecretAccessKey || !bucketName) {
          res.status(400).json({ error: "aws requires awsAccessKeyId, awsSecretAccessKey, and bucketName" });
          return;
        }
        const existing = await registry.getByType(companyId, type, userId);
        const connector = await registry.upsert({
          companyId,
          userId,
          type,
          status: "connected",
          config: {
            ...(existing?.config ?? {}),
            region,
            bucketName,
            mcpEnabled: true,
          },
          credentials: {
            accessToken: awsAccessKeyId,
            refreshToken: awsSecretAccessKey,
          },
          displayName: bucketName,
        });
        res.json({
          success: true,
          connector: {
            id: connector.id,
            companyId: connector.companyId,
            type: connector.type,
            config: connector.config,
            status: connector.status,
            displayName: connector.displayName,
            lastError: connector.lastError,
            connectedAt: connector.connectedAt,
            disconnectedAt: connector.disconnectedAt,
            createdAt: connector.createdAt,
            updatedAt: connector.updatedAt,
          },
        });
        return;
      }

      // Hostinger manual configuration
      if (type === "hostinger") {
        const apiToken = readNonEmptyString(payload.apiToken);
        const domain = readNonEmptyString(payload.domain);
        if (!apiToken) {
          res.status(400).json({ error: "hostinger requires apiToken" });
          return;
        }
        const existing = await registry.getByType(companyId, type, userId);
        const connector = await registry.upsert({
          companyId,
          userId,
          type,
          status: "connected",
          config: {
            ...(existing?.config ?? {}),
            domain: domain ?? null,
            mcpEnabled: true,
          },
          credentials: {
            accessToken: apiToken,
          },
          displayName: domain ?? "Hostinger",
        });
        res.json({
          success: true,
          connector: {
            id: connector.id,
            companyId: connector.companyId,
            type: connector.type,
            config: connector.config,
            status: connector.status,
            displayName: connector.displayName,
            lastError: connector.lastError,
            connectedAt: connector.connectedAt,
            disconnectedAt: connector.disconnectedAt,
            createdAt: connector.createdAt,
            updatedAt: connector.updatedAt,
          },
        });
        return;
      }

      // Surge manual configuration
      if (type === "surge") {
        const token = readNonEmptyString(payload.token);
        const defaultDomain = readNonEmptyString(payload.default_domain ?? payload.defaultDomain);
        if (!token) {
          res.status(400).json({ error: "surge requires token" });
          return;
        }
        const existing = await registry.getByType(companyId, type, userId);
        const connector = await registry.upsert({
          companyId,
          userId,
          type,
          status: "connected",
          config: {
            ...(existing?.config ?? {}),
            default_domain: defaultDomain ?? null,
            mcpEnabled: true,
          },
          credentials: {
            accessToken: token,
          },
          displayName: defaultDomain ?? "Surge.sh",
        });
        res.json({
          success: true,
          connector: {
            id: connector.id,
            companyId: connector.companyId,
            type: connector.type,
            config: connector.config,
            status: connector.status,
            displayName: connector.displayName,
            lastError: connector.lastError,
            connectedAt: connector.connectedAt,
            disconnectedAt: connector.disconnectedAt,
            createdAt: connector.createdAt,
            updatedAt: connector.updatedAt,
          },
        });
        return;
      }

      const accessToken = readNonEmptyString(payload.accessToken);
      if (!accessToken) {
        res.status(400).json({ error: "github requires accessToken" });
        return;
      }
      const existing = await registry.getByType(companyId, type, userId);
      const connector = await registry.upsert({
        companyId,
        userId,
        type,
        status: "connected",
        config: {
          ...(existing?.config ?? {}),
          mcpEnabled: true,
        },
        credentials: {
          accessToken,
        },
        displayName: "GitHub PAT",
      });
      res.json({
        success: true,
        connector: {
          id: connector.id,
          companyId: connector.companyId,
          type: connector.type,
          config: connector.config,
          status: connector.status,
          displayName: connector.displayName,
          lastError: connector.lastError,
          connectedAt: connector.connectedAt,
          disconnectedAt: connector.disconnectedAt,
          createdAt: connector.createdAt,
          updatedAt: connector.updatedAt,
        },
      });
    } catch (err) {
      if (isMissingConnectorsTableError(err)) {
        logger.warn({ err }, "Connector table missing; cannot configure connector");
        res.status(503).json({ error: "Connectors storage is not initialized on this instance" });
        return;
      }
      logger.error({ err }, "Failed to configure manual connector");
      res.status(500).json({ error: "Internal error" });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/connectors/:type/connect — initiate OAuth
  // -------------------------------------------------------------------------
  router.post("/:type/connect", async (req: Request, res: Response) => {
    assertAuthenticated(req);
    assertBoard(req);
    try {
      const companyId = await resolveCompanyId(req);
      const userId = resolveActorUserId(req);
      const type = req.params.type as ConnectorType;
      if (!ALL_CONNECTOR_TYPES.includes(type)) {
        res.status(400).json({ error: "Invalid connector type" });
        return;
      }
      if (!OAUTH_CONNECTOR_TYPES.includes(type)) {
        res.status(400).json({ error: `Use /api/connectors/${type}/configure for this connector` });
        return;
      }

      const config = getOAuthConfig(type, getBaseUrl);
      if (!config?.clientId) {
        if (type === META_ADS_CONNECTOR_TYPE) {
          res.status(503).json({
            error: "Meta Ads App credentials not configured — set META_ADS_APP_ID and META_ADS_APP_SECRET in your environment",
          });
          return;
        }
        res.status(503).json({ error: `OAuth not configured for ${type}` });
        return;
      }

      // Mark connector as "connecting" immediately
      await registry.upsert({ companyId, userId, type, status: "connecting" });

      clearOAuthStatesForCompanyAndType(companyId, userId, type);
      const returnPath = resolveReturnPath(req);
      const { state, oauthState } = createOAuthState(companyId, userId, type, returnPath);
      const verifier = oauthState.verifier;
      const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      const authUrl = buildAuthorizationUrl(type, config, state, challenge);

      logger.info({ companyId, type, state }, "Initiating OAuth flow");
      if (type === GOOGLE_CONNECTOR_TYPE) {
        res.json({
          authorizationUrl: authUrl,
          authUrl,
          state,
          provider: "gworkspace",
          scopes: [...GOOGLE_OAUTH_SCOPES],
          next_step: "redirect",
        });
        return;
      }
      if (type === META_ADS_CONNECTOR_TYPE) {
        res.json({
          authorizationUrl: authUrl,
          authUrl,
          state,
          provider: "meta_ads",
          scopes: [...META_ADS_OAUTH_SCOPES],
          next_step: "redirect",
        });
        return;
      }
      res.json({ authorizationUrl: authUrl, state });
    } catch (err) {
      if (isMissingConnectorsTableError(err)) {
        logger.warn({ err }, "Connector table missing; cannot initiate OAuth");
        res.status(503).json({ error: "Connectors storage is not initialized on this instance" });
        return;
      }
      logger.error({ err }, "Failed to initiate OAuth");
      res.status(500).json({ error: "Internal error" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/connectors/:type/callback — OAuth callback
  // -------------------------------------------------------------------------
  router.get("/:type/callback", handleOAuthCallback);

  // -------------------------------------------------------------------------
  // POST /api/connectors/:type/callback — OAuth callback (form_post support)
  // -------------------------------------------------------------------------
  router.post("/:type/callback", urlencoded({ extended: false }), handleOAuthCallback);

  // -------------------------------------------------------------------------
  // DELETE /api/connectors/:type — disconnect
  // -------------------------------------------------------------------------
  router.delete("/:type", async (req: Request, res: Response) => {
    assertAuthenticated(req);
    assertBoard(req);
    try {
      const companyId = await resolveCompanyId(req);
      const userId = resolveActorUserId(req);
      const type = req.params.type as ConnectorType;
      if (!ALL_CONNECTOR_TYPES.includes(type)) {
        res.status(400).json({ error: "Invalid connector type" });
        return;
      }

      const result = await registry.disconnectForUser(companyId, type, userId);
      if (!result) {
        res.status(404).json({ error: "Connector not found" });
        return;
      }

      logger.info({ companyId, type }, "Connector disconnected");
      res.json({ success: true });
    } catch (err) {
      if (isMissingConnectorsTableError(err)) {
        logger.warn({ err }, "Connector table missing; cannot disconnect connector");
        res.status(503).json({ error: "Connectors storage is not initialized on this instance" });
        return;
      }
      logger.error({ err }, "Failed to disconnect connector");
      res.status(500).json({ error: "Internal error" });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/connectors/:type/enable — enable MCP tools for a connector
  // -------------------------------------------------------------------------
  router.post("/:type/enable", async (req: Request, res: Response) => {
    assertAuthenticated(req);
    assertBoard(req);
    try {
      const companyId = await resolveCompanyId(req);
      const userId = resolveActorUserId(req);
      const type = req.params.type as ConnectorType;
      if (!ALL_CONNECTOR_TYPES.includes(type)) {
        res.status(400).json({ error: "Invalid connector type" });
        return;
      }

      const existing = await registry.getByType(companyId, type, userId);
      const connector = await registry.upsert({
        companyId,
        userId,
        type,
        status: "connected",
        config: {
          ...(existing?.config ?? {}),
          mcpEnabled: true,
        },
      });

      logger.info({ companyId, type }, "Connector MCP enabled");
      res.json({ success: true, connector });
    } catch (err) {
      if (isMissingConnectorsTableError(err)) {
        logger.warn({ err }, "Connector table missing; cannot enable connector MCP");
        res.status(503).json({ error: "Connectors storage is not initialized on this instance" });
        return;
      }
      logger.error({ err }, "Failed to enable connector MCP");
      res.status(500).json({ error: "Internal error" });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/connectors/:type/disable — disable MCP tools for a connector
  // -------------------------------------------------------------------------
  router.post("/:type/disable", async (req: Request, res: Response) => {
    assertAuthenticated(req);
    assertBoard(req);
    try {
      const companyId = await resolveCompanyId(req);
      const userId = resolveActorUserId(req);
      const type = req.params.type as ConnectorType;
      if (!ALL_CONNECTOR_TYPES.includes(type)) {
        res.status(400).json({ error: "Invalid connector type" });
        return;
      }

      const existing = await registry.getByType(companyId, type, userId);
      const connector = await registry.upsert({
        companyId,
        userId,
        type,
        status: "connected",
        config: {
          ...(existing?.config ?? {}),
          mcpEnabled: false,
        },
      });

      logger.info({ companyId, type }, "Connector MCP disabled");
      res.json({ success: true, connector });
    } catch (err) {
      if (isMissingConnectorsTableError(err)) {
        logger.warn({ err }, "Connector table missing; cannot disable connector MCP");
        res.status(503).json({ error: "Connectors storage is not initialized on this instance" });
        return;
      }
      logger.error({ err }, "Failed to disable connector MCP");
      res.status(500).json({ error: "Internal error" });
    }
  });

  return router;
}
