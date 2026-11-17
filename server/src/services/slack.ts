import type { Db } from "@paperclipai/db";
import { companyConnectors, slackChannelRoutes } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { connectorRegistryService } from "./connector-registry.js";
import { getPublicBaseUrl } from "../lib/public-url.js";

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

export interface SlackWorkspaceMetadata {
  workspaceId: string;
  workspaceName: string | null;
  workspaceDomain: string | null;
  enterpriseId: string | null;
  enterpriseName: string | null;
  botUserId: string | null;
  scope: string[];
}

export function readSlackWorkspaceMetadata(raw: unknown): SlackWorkspaceMetadata | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const workspaceId = readTrimmedString(record.teamId) ?? readTrimmedString(record.workspaceId);
  if (!workspaceId) return null;
  return {
    workspaceId,
    workspaceName: readTrimmedString(record.teamName) ?? readTrimmedString(record.workspaceName),
    workspaceDomain: readTrimmedString(record.teamDomain),
    enterpriseId: readTrimmedString(record.enterpriseId),
    enterpriseName: readTrimmedString(record.enterpriseName),
    botUserId: readTrimmedString(record.botUserId),
    scope: (Array.isArray(record.scope) ? record.scope : (readTrimmedString(record.scope) ?? "").split(","))
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0),
  };
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
  /** Reply inside an existing thread instead of posting a new top-level message. */
  threadTs?: string | null;
  clientMsgId?: string | null;
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

  /** Slack's error string (e.g. "invalid_auth"); alias of `code`. */
  get slackError(): string {
    return this.code;
  }
}

export function isRetryableSlackError(error: unknown): boolean {
  if (error instanceof SlackApiError) return error.retryable;
  return error instanceof Error;
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
    redirectUri: `${getPublicBaseUrl()}/api/connectors/slack/callback`,
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

/**
 * Which company's Slack connection posts for `companyId` in `channelId`.
 * A channel can be mapped (Instance settings → Slack) to a company that has no
 * Slack connection of its own; it then posts through the mapping's connection.
 */
export async function resolveSlackTokenCompanyId(db: Db, companyId: string, channelId: string): Promise<string> {
  const own = await connectorRegistryService(db).getByType(companyId, "slack", null);
  if (own?.status === "connected") return companyId;
  const viaRoute = await db
    .select({ connectorCompanyId: companyConnectors.companyId })
    .from(slackChannelRoutes)
    .innerJoin(companyConnectors, eq(companyConnectors.id, slackChannelRoutes.connectorId))
    .where(and(eq(slackChannelRoutes.companyId, companyId), eq(slackChannelRoutes.channelId, channelId)))
    .then((rows) => rows[0]?.connectorCompanyId ?? null);
  return viaRoute ?? companyId;
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

export interface SlackMember {
  id: string;
  /** Slack handle (legacy `name`). */
  handle: string | null;
  realName: string | null;
  displayName: string | null;
  title: string | null;
  timezone: string | null;
}

type SlackUsersListResponse = {
  ok?: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
  members?: Array<{
    id?: string;
    name?: string;
    deleted?: boolean;
    is_bot?: boolean;
    is_app_user?: boolean;
    tz?: string;
    real_name?: string;
    profile?: { real_name?: string; display_name?: string; title?: string };
  }>;
};

/** Active human members of the company's Slack workspace (bots, apps and deactivated users excluded). */
export async function listSlackMembers(db: Db, companyId: string): Promise<SlackMember[]> {
  const accessToken = await getFreshSlackAccessToken(db, companyId);
  const members: SlackMember[] = [];
  let cursor: string | null = null;

  do {
    const params = new URLSearchParams({ limit: "200", ...(cursor ? { cursor } : {}) });
    const response = await slackFetchJson<SlackUsersListResponse>(
      `${SLACK_API_BASE_URL}/users.list?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    for (const member of response.members ?? []) {
      const id = readTrimmedString(member.id);
      if (!id || id === "USLACKBOT" || member.deleted === true || member.is_bot === true || member.is_app_user === true) continue;
      members.push({
        id,
        handle: readTrimmedString(member.name),
        realName: readTrimmedString(member.profile?.real_name) ?? readTrimmedString(member.real_name),
        displayName: readTrimmedString(member.profile?.display_name),
        title: readTrimmedString(member.profile?.title),
        timezone: readTrimmedString(member.tz),
      });
    }

    cursor = readTrimmedString(response.response_metadata?.next_cursor);
  } while (cursor);

  return members;
}

type SlackUsersInfoResponse = {
  ok?: boolean;
  error?: string;
  user?: {
    id?: string;
    name?: string;
    real_name?: string;
    profile?: { real_name?: string; display_name?: string };
  };
};

const SLACK_USER_NAME_CACHE_TTL_MS = 60 * 60 * 1000;
const slackUserNameCache = new Map<string, { name: string; expiresAt: number }>();

/**
 * Best-effort human name for a Slack user: full (real) name, then display name,
 * then handle. Returns null when the lookup fails so callers can fall back to the ID.
 */
export async function getSlackUserName(
  db: Db,
  companyId: string,
  userId: string,
  options: { channelId?: string } = {},
): Promise<string | null> {
  const cacheKey = `${companyId}:${userId}`;
  const cached = slackUserNameCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.name;
  try {
    const tokenCompanyId = options.channelId
      ? await resolveSlackTokenCompanyId(db, companyId, options.channelId)
      : companyId;
    const accessToken = await getFreshSlackAccessToken(db, tokenCompanyId);
    const params = new URLSearchParams({ user: userId });
    const response = await slackFetchJson<SlackUsersInfoResponse>(
      `${SLACK_API_BASE_URL}/users.info?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const user = response.user;
    const name =
      readTrimmedString(user?.profile?.real_name)
      ?? readTrimmedString(user?.real_name)
      ?? readTrimmedString(user?.profile?.display_name)
      ?? readTrimmedString(user?.name);
    if (!name) return null;
    slackUserNameCache.set(cacheKey, { name, expiresAt: Date.now() + SLACK_USER_NAME_CACHE_TTL_MS });
    return name;
  } catch {
    return null;
  }
}

export function resetSlackUserNameCacheForTests() {
  slackUserNameCache.clear();
}

export async function postSlackMessage(
  db: Db,
  companyId: string,
  input: SlackPostMessageInput,
): Promise<SlackPostMessageResult> {
  const accessToken = await getFreshSlackAccessToken(db, await resolveSlackTokenCompanyId(db, companyId, input.channelId));
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
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      ...(input.clientMsgId ? { client_msg_id: input.clientMsgId } : {}),
      unfurl_links: false,
      unfurl_media: false,
    }),
  });

  return {
    channelId: readTrimmedString(response.channel) ?? input.channelId,
    messageTs: readTrimmedString(response.ts),
  };
}

// ---------------------------------------------------------------------------
// Agent read / edit / react helpers. All calls go through the bot token of the
// company that owns the channel (see resolveSlackTokenCompanyId).
// ---------------------------------------------------------------------------

async function callSlackApi<T>(
  db: Db,
  companyId: string,
  channelId: string,
  method: string,
  params: Record<string, unknown>,
  options: { httpMethod?: "GET" | "POST" } = {},
): Promise<T> {
  const accessToken = await getFreshSlackAccessToken(db, await resolveSlackTokenCompanyId(db, companyId, channelId));
  const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if ((options.httpMethod ?? "GET") === "GET") {
    const query = new URLSearchParams(entries.map(([key, value]) => [key, String(value)]));
    return slackFetchJson<T>(`${SLACK_API_BASE_URL}/${method}?${query.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }
  return slackFetchJson<T>(`${SLACK_API_BASE_URL}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(Object.fromEntries(entries)),
  });
}

type SlackRawMessage = {
  type?: string;
  subtype?: string;
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  reply_count?: number;
  latest_reply?: string;
  edited?: { ts?: string };
  files?: Array<{ id?: string; name?: string; title?: string; mimetype?: string; permalink?: string }>;
  reactions?: Array<{ name?: string; count?: number; users?: string[] }>;
};

type SlackMessagesResponse = {
  ok?: boolean;
  messages?: SlackRawMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
};

export interface SlackMessage {
  ts: string;
  threadTs: string | null;
  userId: string | null;
  botId: string | null;
  subtype: string | null;
  text: string;
  replyCount: number;
  latestReplyTs: string | null;
  edited: boolean;
  files: Array<{ id: string | null; name: string | null; mimetype: string | null; permalink: string | null }>;
  reactions: Array<{ name: string; count: number; userIds: string[] }>;
  /** Opens the message in Slack. */
  link: string;
}

export interface SlackMessagePage {
  messages: SlackMessage[];
  hasMore: boolean;
  nextCursor: string | null;
}

export function buildSlackMessageLink(channelId: string, ts: string, threadTs?: string | null): string {
  const base = `https://slack.com/archives/${channelId}/p${ts.replace(".", "")}`;
  return threadTs && threadTs !== ts ? `${base}?thread_ts=${threadTs}&cid=${channelId}` : base;
}

function normalizeSlackMessage(channelId: string, raw: SlackRawMessage): SlackMessage | null {
  const ts = readTrimmedString(raw.ts);
  if (!ts) return null;
  const threadTs = readTrimmedString(raw.thread_ts);
  return {
    ts,
    threadTs,
    userId: readTrimmedString(raw.user),
    botId: readTrimmedString(raw.bot_id),
    subtype: readTrimmedString(raw.subtype),
    text: typeof raw.text === "string" ? raw.text : "",
    replyCount: typeof raw.reply_count === "number" ? raw.reply_count : 0,
    latestReplyTs: readTrimmedString(raw.latest_reply),
    edited: Boolean(raw.edited?.ts),
    files: (raw.files ?? []).map((file) => ({
      id: readTrimmedString(file.id),
      name: readTrimmedString(file.name) ?? readTrimmedString(file.title),
      mimetype: readTrimmedString(file.mimetype),
      permalink: readTrimmedString(file.permalink),
    })),
    reactions: (raw.reactions ?? [])
      .map((reaction) => ({
        name: readTrimmedString(reaction.name) ?? "",
        count: typeof reaction.count === "number" ? reaction.count : 0,
        userIds: (reaction.users ?? []).filter((id): id is string => typeof id === "string"),
      }))
      .filter((reaction) => reaction.name),
    link: buildSlackMessageLink(channelId, ts, threadTs),
  };
}

function toMessagePage(channelId: string, response: SlackMessagesResponse): SlackMessagePage {
  return {
    messages: (response.messages ?? [])
      .map((message) => normalizeSlackMessage(channelId, message))
      .filter((message): message is SlackMessage => message !== null),
    hasMore: response.has_more === true,
    nextCursor: readTrimmedString(response.response_metadata?.next_cursor),
  };
}

export interface SlackHistoryQuery {
  limit?: number;
  /** Only messages after this ts (exclusive). */
  oldest?: string | null;
  /** Only messages before this ts (exclusive). */
  latest?: string | null;
  cursor?: string | null;
}

/** Top-level messages in a channel, newest first (conversations.history). */
export async function listSlackChannelMessages(
  db: Db,
  companyId: string,
  channelId: string,
  query: SlackHistoryQuery = {},
): Promise<SlackMessagePage> {
  const response = await callSlackApi<SlackMessagesResponse>(db, companyId, channelId, "conversations.history", {
    channel: channelId,
    limit: query.limit ?? 50,
    oldest: query.oldest,
    latest: query.latest,
    cursor: query.cursor,
    inclusive: false,
  });
  return toMessagePage(channelId, response);
}

/** The root message and its replies, oldest first (conversations.replies). */
export async function listSlackThreadMessages(
  db: Db,
  companyId: string,
  channelId: string,
  threadTs: string,
  query: Pick<SlackHistoryQuery, "limit" | "cursor"> = {},
): Promise<SlackMessagePage> {
  const response = await callSlackApi<SlackMessagesResponse>(db, companyId, channelId, "conversations.replies", {
    channel: channelId,
    ts: threadTs,
    limit: query.limit ?? 200,
    cursor: query.cursor,
  });
  return toMessagePage(channelId, response);
}

/** One message by ts, including a reply inside a thread. */
export async function getSlackMessage(
  db: Db,
  companyId: string,
  channelId: string,
  ts: string,
): Promise<SlackMessage | null> {
  const response = await callSlackApi<SlackMessagesResponse>(db, companyId, channelId, "conversations.history", {
    channel: channelId,
    latest: ts,
    oldest: ts,
    inclusive: true,
    limit: 1,
  });
  const top = toMessagePage(channelId, response).messages.find((message) => message.ts === ts);
  if (top) return top;
  // Thread replies are not in the channel history; conversations.replies with
  // the reply's own ts returns its thread, from which we pick the reply.
  const thread = await callSlackApi<SlackMessagesResponse>(db, companyId, channelId, "conversations.replies", {
    channel: channelId,
    ts,
    latest: ts,
    oldest: ts,
    inclusive: true,
    limit: 1,
  }).catch((error) => {
    if (error instanceof SlackApiError && error.code === "thread_not_found") return { messages: [] } as SlackMessagesResponse;
    throw error;
  });
  return toMessagePage(channelId, thread).messages.find((message) => message.ts === ts) ?? null;
}

/** Edit a message the bot posted (chat.update). Slack rejects edits of other people's messages. */
export async function updateSlackMessage(
  db: Db,
  companyId: string,
  input: { channelId: string; ts: string; text: string; blocks?: Array<Record<string, unknown>> | null },
): Promise<{ channelId: string; ts: string }> {
  const response = await callSlackApi<{ channel?: string; ts?: string }>(db, companyId, input.channelId, "chat.update", {
    channel: input.channelId,
    ts: input.ts,
    text: input.text,
    ...(input.blocks ? { blocks: input.blocks } : {}),
  }, { httpMethod: "POST" });
  return { channelId: readTrimmedString(response.channel) ?? input.channelId, ts: readTrimmedString(response.ts) ?? input.ts };
}

/** Delete a message the bot posted (chat.delete). */
export async function deleteSlackMessage(db: Db, companyId: string, input: { channelId: string; ts: string }): Promise<void> {
  await callSlackApi(db, companyId, input.channelId, "chat.delete", { channel: input.channelId, ts: input.ts }, { httpMethod: "POST" });
}

/** Add or remove an emoji reaction as the bot (reactions.add / reactions.remove; needs reactions:write). */
export async function setSlackReaction(
  db: Db,
  companyId: string,
  input: { channelId: string; ts: string; name: string; remove?: boolean },
): Promise<void> {
  try {
    await callSlackApi(db, companyId, input.channelId, input.remove ? "reactions.remove" : "reactions.add", {
      channel: input.channelId,
      timestamp: input.ts,
      name: input.name,
    }, { httpMethod: "POST" });
  } catch (error) {
    // Adding a reaction that is already there (or removing one that is not) is a no-op for callers.
    if (error instanceof SlackApiError && (error.code === "already_reacted" || error.code === "no_reaction")) return;
    throw error;
  }
}

/** Join a public channel so the bot can read its history and receive its replies (needs channels:join). */
export async function joinSlackChannel(db: Db, companyId: string, channelId: string): Promise<void> {
  await callSlackApi(db, companyId, channelId, "conversations.join", { channel: channelId }, { httpMethod: "POST" });
}
