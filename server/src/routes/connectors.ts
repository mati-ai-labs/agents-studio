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
 * @fileoverview Connector OAuth routes — initiate/callback/disconnect for
 * Google Workspace, Notion, and Linear.
 *
 * Flow:
 *   1. POST /api/connectors/:type/connect  → redirect to OAuth provider
 *   2. GET  /api/connectors/:type/callback → exchange code for tokens, upsert connector
 *   3. DELETE /api/connectors/:type        → clear credentials, set disconnected
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
import type { Db } from "@paperclipai/db";
import { connectorRegistryService } from "../services/connector-registry.js";
import {
  assertAuthenticated,
  assertBoard,
} from "./authz.js";
import { badRequest } from "../errors.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ConnectorType = "google_workspace" | "notion" | "linear";

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
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.file",
    ],
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

function getOAuthConfig(type: ConnectorType, getBaseUrl: () => string): ConnectorOAuthConfig | null {
  switch (type) {
    case "google_workspace": return getGoogleOAuthConfig(getBaseUrl);
    case "notion": return getNotionOAuthConfig(getBaseUrl);
    case "linear": return getLinearOAuthConfig(getBaseUrl);
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

function buildAuthorizationUrl(
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
  return `${config.authorizationUrl}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// State management (in-memory for OAuth flow — tied to session)
// ---------------------------------------------------------------------------

interface OAuthState {
  companyId: string;
  type: ConnectorType;
  verifier: string;
}

// Simple in-memory store keyed by state token
const oauthStateStore = new Map<string, OAuthState>();

function createOAuthState(companyId: string, type: ConnectorType): { state: string; oauthState: OAuthState } {
  const state = crypto.randomBytes(32).toString("base64url");
  const verifier = crypto.randomBytes(64).toString("base64url");
  const oauthState: OAuthState = { companyId, type, verifier };
  oauthStateStore.set(state, oauthState);
  // Auto-expire after 10 minutes
  setTimeout(() => oauthStateStore.delete(state), 10 * 60 * 1000);
  return { state, oauthState };
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

  async function handleOAuthCallback(req: Request, res: Response): Promise<void> {
    try {
      const baseUrl = getBaseUrl();
      const callbackParams = {
        ...(req.query as Record<string, string>),
        ...((req.body ?? {}) as Record<string, string>),
      };
      const { code, state, error: oauthError } = callbackParams;

      if (oauthError) {
        logger.warn({ oauthError }, "OAuth error from provider");
        res.redirect(`${baseUrl}/connectors?error=${encodeURIComponent(oauthError)}`);
        return;
      }

      if (!state || !code) {
        res.redirect(`${baseUrl}/connectors?error=missing_params`);
        return;
      }

      const oauthState = oauthStateStore.get(state);
      if (!oauthState) {
        res.redirect(`${baseUrl}/connectors?error=invalid_state`);
        return;
      }
      oauthStateStore.delete(state);

      const { companyId, type: connectorType, verifier } = oauthState;
      const config = getOAuthConfig(connectorType as ConnectorType, getBaseUrl);

      if (!config) {
        res.redirect(`${baseUrl}/connectors?error=unknown_type`);
        return;
      }

      // Exchange code for tokens
      const tokens = await exchangeCodeForTokens(config, code, verifier);

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
        type: connectorType as ConnectorType,
        status: "connected",
        credentials: tokens,
        displayName,
      });

      logger.info({ companyId, type: connectorType }, "Connector connected successfully");
      res.redirect(`${baseUrl}/connectors?connected=${connectorType}`);
    } catch (err) {
      logger.error({ err }, "OAuth callback failed");
      res.redirect(`${getBaseUrl()}/connectors?error=callback_failed`);
    }
  }

  // -------------------------------------------------------------------------
  // GET /api/connectors — list all connectors for the authenticated company
  // -------------------------------------------------------------------------
  router.get("/", assertAuthenticated, assertBoard, async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).board.companyId as string;
      const connectors = await registry.listByCompany(companyId);
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
      logger.error({ err }, "Failed to list connectors");
      res.status(500).json({ error: "Internal error" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/connectors/:type — get connector status
  // -------------------------------------------------------------------------
  router.get("/:type", assertAuthenticated, assertBoard, async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).board.companyId as string;
      const type = req.params.type as ConnectorType;
      if (!["google_workspace", "notion", "linear"].includes(type)) {
        res.status(400).json({ error: "Invalid connector type" });
        return;
      }
      const connector = await registry.getByType(companyId, type);
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
      logger.error({ err }, "Failed to get connector");
      res.status(500).json({ error: "Internal error" });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/connectors/:type/connect — initiate OAuth
  // -------------------------------------------------------------------------
  router.post("/:type/connect", assertAuthenticated, assertBoard, async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).board.companyId as string;
      const type = req.params.type as ConnectorType;
      if (!["google_workspace", "notion", "linear"].includes(type)) {
        res.status(400).json({ error: "Invalid connector type" });
        return;
      }

      const config = getOAuthConfig(type, getBaseUrl);
      if (!config?.clientId) {
        res.status(503).json({ error: `OAuth not configured for ${type}` });
        return;
      }

      // Mark connector as "connecting" immediately
      await registry.upsert({ companyId, type, status: "connecting" });

      const { state, oauthState } = createOAuthState(companyId, type);
      const verifier = oauthState.verifier;
      const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      const authUrl = buildAuthorizationUrl(config, state, challenge);

      logger.info({ companyId, type, state }, "Initiating OAuth flow");
      res.json({ authorizationUrl: authUrl, state });
    } catch (err) {
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
  router.delete("/:type", assertAuthenticated, assertBoard, async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).board.companyId as string;
      const type = req.params.type as ConnectorType;
      if (!["google_workspace", "notion", "linear"].includes(type)) {
        res.status(400).json({ error: "Invalid connector type" });
        return;
      }

      const result = await registry.disconnect(companyId, type);
      if (!result) {
        res.status(404).json({ error: "Connector not found" });
        return;
      }

      logger.info({ companyId, type }, "Connector disconnected");
      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, "Failed to disconnect connector");
      res.status(500).json({ error: "Internal error" });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/connectors/:type/enable — enable MCP tools for a connector
  // -------------------------------------------------------------------------
  router.post("/:type/enable", assertAuthenticated, assertBoard, async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).board.companyId as string;
      const type = req.params.type as ConnectorType;
      if (!["google_workspace", "notion", "linear"].includes(type)) {
        res.status(400).json({ error: "Invalid connector type" });
        return;
      }

      const existing = await registry.getByType(companyId, type);
      const connector = await registry.upsert({
        companyId,
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
      logger.error({ err }, "Failed to enable connector MCP");
      res.status(500).json({ error: "Internal error" });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/connectors/:type/disable — disable MCP tools for a connector
  // -------------------------------------------------------------------------
  router.post("/:type/disable", assertAuthenticated, assertBoard, async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).board.companyId as string;
      const type = req.params.type as ConnectorType;
      if (!["google_workspace", "notion", "linear"].includes(type)) {
        res.status(400).json({ error: "Invalid connector type" });
        return;
      }

      const existing = await registry.getByType(companyId, type);
      const connector = await registry.upsert({
        companyId,
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
      logger.error({ err }, "Failed to disable connector MCP");
      res.status(500).json({ error: "Internal error" });
    }
  });

  return router;
}
