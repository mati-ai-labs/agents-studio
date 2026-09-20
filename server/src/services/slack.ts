import type { Db } from "@paperclipai/db";
import { connectorRegistryService } from "./connector-registry.js";

const SLACK_API_BASE_URL = "https://slack.com/api";
const SLACK_EXPIRY_REFRESH_SKEW_MS = 60_000;

export interface SlackOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface SlackWorkspaceInstallation {
  appId: string | null;
  teamId: string;
  teamName: string;
  teamDomain: string | null;
  enterpriseId: string | null;
  enterpriseName: string | null;
  botUserId: string | null;
  scope: string | null;
  tokenType: string | null;
}

export interface SlackOAuthExchangeResult {
  credentials: {
    accessToken: string;
    refreshToken?: string;
    expiry?: number;
  };
  installation: SlackWorkspaceInstallation;
}

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
  isArchived: boolean;
}

export interface SlackPostMessageInput {
  channelId: string;
  text: string;
  blocks?: Array<Record<string, unknown>>;
}

export interface SlackPostMessageResult {
  channelId: string;
  messageTs: string | null;
}

type SlackTokenResponse = {
  ok?: boolean;
  error?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  app_id?: string;
  bot_user_id?: string;
  team?: {
    id?: string;
    name?: string;
    domain?: string;
  };
  enterprise?: {
    id?: string;
    name?: string;
  };
};

type SlackConversationsListResponse = {
  ok?: boolean;
  error?: string;
  response_metadata?: {
    next_cursor?: string;
  };
  channels?: Array<{
    id?: string;
    name?: string;
    is_private?: boolean;
    is_member?: boolean;
    is_archived?: boolean;
  }>;
};

type SlackPostMessageResponse = {
  ok?: boolean;
  error?: string;
  channel?: string;
  ts?: string;
};

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseSlackExpiry(expiresInSeconds: number | undefined): number | undefined {
  if (typeof expiresInSeconds !== "number" || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
    return undefined;
  }
  return Date.now() + expiresInSeconds * 1_000;
}

function isRetryableSlackErrorCode(code: string | null): boolean {
  return code === "ratelimited"
    || code === "internal_error"
    || code === "fatal_error"
    || code === "request_timeout"
    || code === "service_unavailable";
}

function slackRetryableForHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function readRetryAfterMs(response: Response): number | undefined {
  const retryAfter = readTrimmedString(response.headers.get("retry-after"));
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.floor(seconds * 1_000);
}

export class SlackApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: {
      code: string;
      retryable: boolean;
      status?: number;
      retryAfterMs?: number;
    },
  ) {
    super(message);
    this.name = "SlackApiError";
    this.code = options.code;
    this.retryable = options.retryable;
    this.status = options.status ?? 500;
    this.retryAfterMs = options.retryAfterMs;
  }
}

function buildSlackApiError(code: string | null, response: Response, fallbackMessage: string): SlackApiError {
  return new SlackApiError(code ?? fallbackMessage, {
    code: code ?? "slack_api_error",
    retryable: code ? isRetryableSlackErrorCode(code) : slackRetryableForHttpStatus(response.status),
    status: response.status,
    retryAfterMs: readRetryAfterMs(response),
  });
}

async function slackFetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (error) {
    throw new SlackApiError(
      error instanceof Error && error.message ? error.message : "Slack request failed",
      {
        code: "slack_transport_error",
        retryable: true,
      },
    );
  }

  const payload = await response.json().catch(async () => {
    const bodyText = await response.text().catch(() => "");
    throw new SlackApiError(bodyText || "Slack returned an invalid response", {
      code: "slack_invalid_response",
      retryable: slackRetryableForHttpStatus(response.status),
      status: response.status,
      retryAfterMs: readRetryAfterMs(response),
    });
  });

  if (!response.ok) {
    const errorCode = readTrimmedString((payload as { error?: unknown }).error);
    throw buildSlackApiError(errorCode, response, `Slack request failed with HTTP ${response.status}`);
  }

  const ok = (payload as { ok?: unknown }).ok;
  if (ok === false) {
    const errorCode = readTrimmedString((payload as { error?: unknown }).error);
    throw buildSlackApiError(errorCode, response, "Slack request was rejected");
  }

  return payload as T;
}

function requireSlackOAuthConfig(input: SlackOAuthConfig): SlackOAuthConfig {
  if (!input.clientId || !input.clientSecret || !input.redirectUri) {
    throw new SlackApiError("Slack OAuth is not configured", {
      code: "slack_oauth_not_configured",
      retryable: false,
      status: 503,
    });
  }
  return input;
}

function buildSlackTokenUrlParams(base: Record<string, string>): string {
  const params = new URLSearchParams(base);
  return params.toString();
}

function readSlackInstallation(data: SlackTokenResponse): SlackWorkspaceInstallation {
  const teamId = readTrimmedString(data.team?.id);
  const teamName = readTrimmedString(data.team?.name);
  if (!teamId || !teamName) {
    throw new SlackApiError("Slack OAuth response did not include workspace metadata", {
      code: "slack_missing_team_metadata",
      retryable: false,
      status: 502,
    });
  }

  return {
    appId: readTrimmedString(data.app_id),
    teamId,
    teamName,
    teamDomain: readTrimmedString(data.team?.domain),
    enterpriseId: readTrimmedString(data.enterprise?.id),
    enterpriseName: readTrimmedString(data.enterprise?.name),
    botUserId: readTrimmedString(data.bot_user_id),
    scope: readTrimmedString(data.scope),
    tokenType: readTrimmedString(data.token_type),
  };
}

function readSlackAccessToken(data: SlackTokenResponse): string {
  const accessToken = readTrimmedString(data.access_token);
  if (!accessToken) {
    throw new SlackApiError("Slack OAuth response did not include a bot token", {
      code: "slack_missing_access_token",
      retryable: false,
      status: 502,
    });
  }
  return accessToken;
}

export async function exchangeSlackOAuthCode(
  configInput: SlackOAuthConfig,
  code: string,
  codeVerifier: string,
): Promise<SlackOAuthExchangeResult> {
  const config = requireSlackOAuthConfig(configInput);
  const body = buildSlackTokenUrlParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: config.redirectUri,
    code_verifier: codeVerifier,
  });

  const response = await slackFetchJson<SlackTokenResponse>(`${SLACK_API_BASE_URL}/oauth.v2.access`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  return {
    credentials: {
      accessToken: readSlackAccessToken(response),
      refreshToken: readTrimmedString(response.refresh_token) ?? undefined,
      expiry: parseSlackExpiry(response.expires_in),
    },
    installation: readSlackInstallation(response),
  };
}

export async function refreshSlackAccessToken(
  configInput: SlackOAuthConfig,
  refreshToken: string,
): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiry?: number;
}> {
  const config = requireSlackOAuthConfig(configInput);
  const body = buildSlackTokenUrlParams({
    grant_type: "refresh_token",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
  });

  const response = await slackFetchJson<SlackTokenResponse>(`${SLACK_API_BASE_URL}/oauth.v2.access`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  return {
    accessToken: readSlackAccessToken(response),
    refreshToken: readTrimmedString(response.refresh_token) ?? undefined,
    expiry: parseSlackExpiry(response.expires_in),
  };
}

async function getFreshSlackAccessToken(
  db: Db,
  companyId: string,
): Promise<string> {
  const registry = connectorRegistryService(db);
  const connector = await registry.getByType(companyId, "slack", null);
  if (!connector || connector.status !== "connected") {
    throw new SlackApiError("Slack is not connected for this company", {
      code: "slack_not_connected",
      retryable: false,
      status: 409,
    });
  }

  const credentials = await registry.getCredentialsAsync(companyId, "slack");
  if (!credentials?.accessToken) {
    throw new SlackApiError("Slack credentials are missing", {
      code: "slack_missing_credentials",
      retryable: false,
      status: 409,
    });
  }

  const expiresAt = typeof credentials.expiry === "number" ? credentials.expiry : null;
  if (!expiresAt || expiresAt > Date.now() + SLACK_EXPIRY_REFRESH_SKEW_MS) {
    return credentials.accessToken;
  }

  if (!credentials.refreshToken) {
    throw new SlackApiError("Slack token expired and cannot be refreshed", {
      code: "slack_refresh_token_missing",
      retryable: false,
      status: 409,
    });
  }

  const refreshed = await refreshSlackAccessToken({
    clientId: process.env.SLACK_CLIENT_ID ?? "",
    clientSecret: process.env.SLACK_CLIENT_SECRET ?? "",
    redirectUri: `${process.env.PAPERCLIP_API_URL?.trim()
      || process.env.PAPERCLIP_RUNTIME_API_URL?.trim()
      || `http://127.0.0.1:${process.env.PORT ?? 3100}`}/api/connectors/slack/callback`,
  }, credentials.refreshToken);

  await registry.upsert({
    companyId,
    type: "slack",
    status: "connected",
    credentials: {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? credentials.refreshToken,
      expiry: refreshed.expiry,
    },
  });
  await registry.updateStatus(companyId, "slack", "connected");
  return refreshed.accessToken;
}

export async function listSlackChannels(db: Db, companyId: string): Promise<SlackChannel[]> {
  const accessToken = await getFreshSlackAccessToken(db, companyId);
  const channels: SlackChannel[] = [];
  let cursor: string | null = null;

  do {
    const params = new URLSearchParams({
      exclude_archived: "true",
      limit: "200",
      types: "public_channel,private_channel",
      ...(cursor ? { cursor } : {}),
    });
    const response = await slackFetchJson<SlackConversationsListResponse>(
      `${SLACK_API_BASE_URL}/conversations.list?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    for (const channel of response.channels ?? []) {
      const id = readTrimmedString(channel.id);
      const name = readTrimmedString(channel.name);
      if (!id || !name) continue;
      channels.push({
        id,
        name,
        isPrivate: channel.is_private === true,
        isMember: channel.is_member === true,
        isArchived: channel.is_archived === true,
      });
    }

    cursor = readTrimmedString(response.response_metadata?.next_cursor);
  } while (cursor);

  channels.sort((left, right) => left.name.localeCompare(right.name));
  return channels;
}

export async function postSlackMessage(
  db: Db,
  companyId: string,
  input: SlackPostMessageInput,
): Promise<SlackPostMessageResult> {
  const accessToken = await getFreshSlackAccessToken(db, companyId);
  const response = await slackFetchJson<SlackPostMessageResponse>(`${SLACK_API_BASE_URL}/chat.postMessage`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: input.channelId,
      text: input.text,
      ...(Array.isArray(input.blocks) && input.blocks.length > 0 ? { blocks: input.blocks } : {}),
      unfurl_links: false,
      unfurl_media: false,
    }),
  });

  return {
    channelId: readTrimmedString(response.channel) ?? input.channelId,
    messageTs: readTrimmedString(response.ts),
  };
}
