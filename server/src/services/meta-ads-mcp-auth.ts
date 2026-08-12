/**
 * @fileoverview Meta Ads MCP auth — per-tenant token resolver.
 *
 * Mirrors the Google Workspace MCP auth pattern (`google-workspace-mcp-auth.ts`):
 * the connector registry stores encrypted OAuth credentials, and this service
 * resolves a fresh bearer token for a given company, refreshing if needed.
 *
 * Meta's OAuth flow does not use a true "refresh token" the way Google does.
 * Instead, short-lived tokens (~2 hours) returned by the authorization-code
 * exchange are converted to long-lived tokens (~60 days) via the
 * `fb_exchange_token` grant on `graph.facebook.com/v18.0/oauth/access_token`.
 * Long-lived tokens can also be re-exchanged to extend their expiry as long
 * as they are still valid. We treat the existing `accessToken` as the
 * exchangeable token and call `fb_exchange_token` against the Meta token
 * endpoint to refresh it.
 *
 * If `META_ADS_APP_ID` / `META_ADS_APP_SECRET` env vars are not set, refresh
 * is skipped and a warning is logged — callers receive the stored token
 * unchanged. This lets the UI render the "Connect" tile before real Meta App
 * credentials are wired in.
 */

import type { Db } from "@paperclipai/db";
import { connectorRegistryService } from "./connector-registry.js";
import { logger } from "../middleware/logger.js";

const META_TOKEN_URL = "https://graph.facebook.com/v18.0/oauth/access_token";
const DEFAULT_REFRESH_SKEW_MS = 60_000;
const META_ACCESS_TOKEN_LIFETIME_MS = 60 * 24 * 60 * 60 * 1_000; // ~60 days (long-lived)

export interface MetaAdsMcpAccessTokenResult {
  accessToken: string | null;
  refreshed: boolean;
  expiresAtMs: number | null;
  reason?: string;
}

function readNonEmptyEnv(name: string): string | null {
  const value = process.env[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeExpiryMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value > 0 ? Math.floor(value) : null;
}

export async function resolveMetaAdsMcpAccessToken(input: {
  db: Db;
  companyId: string;
  userId?: string | null;
  nowMs?: number;
  refreshSkewMs?: number;
}): Promise<MetaAdsMcpAccessTokenResult> {
  const registry = connectorRegistryService(input.db);
  const creds = await registry.getCredentialsAsync(input.companyId, "meta_ads", {
    userId: input.userId,
  });
  if (!creds?.accessToken) {
    return {
      accessToken: null,
      refreshed: false,
      expiresAtMs: null,
      reason: "missing_credentials",
    };
  }

  const nowMs = input.nowMs ?? Date.now();
  const refreshSkewMs = input.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  const expiresAtMs = normalizeExpiryMs(creds.expiry);
  const shouldRefresh = expiresAtMs !== null && expiresAtMs <= nowMs + refreshSkewMs;

  if (!shouldRefresh) {
    return {
      accessToken: creds.accessToken,
      refreshed: false,
      expiresAtMs,
    };
  }

  // Expired. Check whether we can attempt a refresh.
  const appId = readNonEmptyEnv("META_ADS_APP_ID");
  const appSecret = readNonEmptyEnv("META_ADS_APP_SECRET");
  if (!appId || !appSecret) {
    logger.warn(
      {
        companyId: input.companyId,
        userId: input.userId ?? null,
      },
      "Meta Ads access token expired and META_ADS_APP_ID / META_ADS_APP_SECRET are not configured — skipping MCP injection for this run",
    );
    return {
      accessToken: null,
      refreshed: false,
      expiresAtMs,
      reason: "missing_meta_ads_oauth_client_config",
    };
  }

  // Meta uses `fb_exchange_token` (a GET against the token endpoint) to
  // upgrade a short-lived token to a long-lived one (or to refresh an
  // existing long-lived token). Treat the stored accessToken as the
  // exchangeable token.
  const params = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: creds.accessToken,
  });
  const url = `${META_TOKEN_URL}?${params.toString()}`;

  let response: Response;
  try {
    response = await fetch(url, { method: "GET" });
  } catch (error) {
    logger.warn(
      {
        companyId: input.companyId,
        userId: input.userId ?? null,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to refresh Meta Ads access token",
    );
    return {
      accessToken: null,
      refreshed: false,
      expiresAtMs,
      reason: "meta_ads_refresh_request_failed",
    };
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    logger.warn(
      {
        companyId: input.companyId,
        userId: input.userId ?? null,
        status: response.status,
        body: errorBody.slice(0, 1_000),
      },
      "Meta Ads token refresh returned non-OK response",
    );
    return {
      accessToken: null,
      refreshed: false,
      expiresAtMs,
      reason: "meta_ads_refresh_failed",
    };
  }

  const json = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    token_type?: string;
  };
  const nextAccessToken =
    typeof json.access_token === "string" && json.access_token.trim().length > 0
      ? json.access_token.trim()
      : null;
  if (!nextAccessToken) {
    logger.warn(
      { companyId: input.companyId },
      "Meta Ads refresh response missing access_token",
    );
    return {
      accessToken: null,
      refreshed: false,
      expiresAtMs,
      reason: "meta_ads_refresh_missing_access_token",
    };
  }

  // Meta does not always return `expires_in` for long-lived tokens; default
  // to the well-known 60-day lifetime so the next refresh happens at the
  // appropriate boundary.
  const nextExpiryMs =
    typeof json.expires_in === "number" && Number.isFinite(json.expires_in) && json.expires_in > 0
      ? nowMs + Math.floor(json.expires_in * 1_000)
      : nowMs + META_ACCESS_TOKEN_LIFETIME_MS;

  await registry.upsert({
    companyId: input.companyId,
    userId: input.userId,
    type: "meta_ads",
    status: "connected",
    credentials: {
      accessToken: nextAccessToken,
      // Meta has no separate refresh_token — reuse the (now long-lived) access token.
      refreshToken: nextAccessToken,
      expiry: nextExpiryMs,
    },
  });

  return {
    accessToken: nextAccessToken,
    refreshed: true,
    expiresAtMs: nextExpiryMs,
  };
}
