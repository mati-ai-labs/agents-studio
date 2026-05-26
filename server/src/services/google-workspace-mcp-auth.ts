import type { Db } from "@paperclipai/db";
import { connectorRegistryService } from "./connector-registry.js";
import { logger } from "../middleware/logger.js";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_REFRESH_SKEW_MS = 60_000;

export interface GoogleWorkspaceMcpAccessTokenResult {
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

export async function resolveGoogleWorkspaceMcpAccessToken(input: {
  db: Db;
  companyId: string;
  userId?: string | null;
  nowMs?: number;
  refreshSkewMs?: number;
}): Promise<GoogleWorkspaceMcpAccessTokenResult> {
  const registry = connectorRegistryService(input.db);
  const creds = await registry.getCredentialsAsync(input.companyId, "google_workspace", {
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

  if (!creds.refreshToken) {
    return {
      accessToken: null,
      refreshed: false,
      expiresAtMs,
      reason: "missing_refresh_token",
    };
  }

  const clientId = readNonEmptyEnv("GOOGLE_CLIENT_ID");
  const clientSecret = readNonEmptyEnv("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return {
      accessToken: null,
      refreshed: false,
      expiresAtMs,
      reason: "missing_google_oauth_client_config",
    };
  }

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: creds.refreshToken,
  });

  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
  } catch (error) {
    logger.warn(
      {
        companyId: input.companyId,
        userId: input.userId ?? null,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to refresh Google Workspace access token",
    );
    return {
      accessToken: null,
      refreshed: false,
      expiresAtMs,
      reason: "google_refresh_request_failed",
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
      "Google Workspace token refresh returned non-OK response",
    );
    return {
      accessToken: null,
      refreshed: false,
      expiresAtMs,
      reason: "google_refresh_failed",
    };
  }

  const json = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
  };
  const nextAccessToken =
    typeof json.access_token === "string" && json.access_token.trim().length > 0
      ? json.access_token.trim()
      : null;
  if (!nextAccessToken) {
    logger.warn(
      { companyId: input.companyId },
      "Google Workspace refresh response missing access_token",
    );
    return {
      accessToken: null,
      refreshed: false,
      expiresAtMs,
      reason: "google_refresh_missing_access_token",
    };
  }

  const nextExpiry =
    typeof json.expires_in === "number" && Number.isFinite(json.expires_in) && json.expires_in > 0
      ? nowMs + Math.floor(json.expires_in * 1_000)
      : undefined;
  const nextRefreshToken =
    typeof json.refresh_token === "string" && json.refresh_token.trim().length > 0
      ? json.refresh_token.trim()
      : creds.refreshToken;

  await registry.upsert({
    companyId: input.companyId,
    userId: input.userId,
    type: "google_workspace",
    status: "connected",
    credentials: {
      accessToken: nextAccessToken,
      refreshToken: nextRefreshToken,
      expiry: nextExpiry,
    },
  });

  return {
    accessToken: nextAccessToken,
    refreshed: true,
    expiresAtMs: nextExpiry ?? null,
  };
}
