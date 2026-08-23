import { logger } from "../middleware/logger.js";

export interface SlackOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface SlackWorkspaceMetadata {
  workspaceId: string;
  workspaceName: string | null;
  workspaceUrl: string | null;
  enterpriseId: string | null;
  enterpriseName: string | null;
  botUserId: string | null;
  installedByUserId: string | null;
  scope: string[];
}

export interface SlackChannelSummary {
  id: string;
  name: string;
  channelType: "public";
  isMember: boolean;
  memberCount: number | null;
}

export interface SlackMessagePostResult {
  channel: string;
  ts: string;
}

type SlackErrorPayload = {
  ok?: boolean;
  error?: string;
  needed?: string;
  provided?: string;
};

type SlackOAuthExchangeResponse = SlackErrorPayload & {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  bot_user_id?: string;
  team?: {
    id?: string;
    name?: string;
  };
  enterprise?: {
    id?: string;
    name?: string;
  };
  authed_user?: {
    id?: string;
  };
};

type SlackAuthTestResponse = SlackErrorPayload & {
  team?: string;
  team_id?: string;
  url?: string;
  user_id?: string;
};

type SlackConversationsListResponse = SlackErrorPayload & {
  channels?: Array<{
    id?: string;
    name?: string;
    is_archived?: boolean;
    is_private?: boolean;
    is_member?: boolean;
    num_members?: number;
  }>;
  response_metadata?: {
    next_cursor?: string;
  };
};

type SlackChatPostMessageResponse = SlackErrorPayload & {
  channel?: string;
  ts?: string;
};

export class SlackApiError extends Error {
  readonly status: number;
  readonly slackError: string | null;
  readonly retryAfterMs: number | null;

  constructor(message: string, options: { status: number; slackError?: string | null; retryAfterMs?: number | null }) {
    super(message);
    this.name = "SlackApiError";
    this.status = options.status;
    this.slackError = options.slackError ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

function normalizeSlackScopes(scope: string | undefined): string[] {
  return (scope ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readRetryAfterMs(response: Response): number | null {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.max(1_000, Math.round(seconds * 1_000));
}

async function parseSlackResponse<T extends SlackErrorPayload>(
  response: Response,
  operation: string,
): Promise<T> {
  const retryAfterMs = readRetryAfterMs(response);
  const text = await response.text();
  let payload: T | null = null;

  try {
    payload = JSON.parse(text) as T;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const slackError = payload?.error ?? null;
    throw new SlackApiError(`${operation} failed with HTTP ${response.status}`, {
      status: response.status,
      slackError,
      retryAfterMs,
    });
  }

  if (payload?.ok === false) {
    throw new SlackApiError(`${operation} failed: ${payload.error ?? "unknown_error"}`, {
      status: response.status,
      slackError: payload.error ?? null,
      retryAfterMs,
    });
  }

  if (!payload) {
    throw new SlackApiError(`${operation} returned invalid JSON`, {
      status: response.status,
      retryAfterMs,
    });
  }

  return payload;
}

async function callSlackFormApi<T extends SlackErrorPayload>(
  accessToken: string,
  method: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  const body = new URLSearchParams(params);
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    ...(signal ? { signal } : {}),
  });
  return parseSlackResponse<T>(response, `Slack ${method}`);
}

async function callSlackJsonApi<T extends SlackErrorPayload>(
  accessToken: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });
  return parseSlackResponse<T>(response, `Slack ${method}`);
}

async function fetchSlackWorkspace(accessToken: string): Promise<SlackAuthTestResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    return await callSlackFormApi<SlackAuthTestResponse>(accessToken, "auth.test", {}, controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

export function readSlackWorkspaceMetadata(raw: unknown): SlackWorkspaceMetadata | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const workspaceId =
    typeof record.workspaceId === "string" && record.workspaceId.trim().length > 0
      ? record.workspaceId.trim()
      : null;
  if (!workspaceId) return null;

  const scope = Array.isArray(record.scope)
    ? record.scope.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];

  return {
    workspaceId,
    workspaceName: typeof record.workspaceName === "string" ? record.workspaceName : null,
    workspaceUrl: typeof record.workspaceUrl === "string" ? record.workspaceUrl : null,
    enterpriseId: typeof record.enterpriseId === "string" ? record.enterpriseId : null,
    enterpriseName: typeof record.enterpriseName === "string" ? record.enterpriseName : null,
    botUserId: typeof record.botUserId === "string" ? record.botUserId : null,
    installedByUserId: typeof record.installedByUserId === "string" ? record.installedByUserId : null,
    scope,
  };
}

export async function exchangeSlackCodeForTokens(
  config: SlackOAuthConfig,
  code: string,
): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiry?: number;
  workspace: SlackWorkspaceMetadata;
  displayName: string;
}> {
  const params = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: config.redirectUri,
  });

  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const payload = await parseSlackResponse<SlackOAuthExchangeResponse>(response, "Slack OAuth exchange");
  const accessToken = typeof payload.access_token === "string" ? payload.access_token.trim() : "";

  if (!accessToken) {
    throw new SlackApiError("Slack OAuth exchange returned no access token", { status: response.status });
  }

  // Slack's token exchange already returns the workspace identity. `auth.test`
  // is useful for the richer URL/user metadata, but Slack can occasionally
  // hold that request and return HTTP 408 immediately after an install. Do not
  // make the OAuth browser callback wait for that optional enrichment call.
  let auth: SlackAuthTestResponse = {};
  try {
    auth = await fetchSlackWorkspace(accessToken);
  } catch (err) {
    if (payload.team?.id) {
      logger.warn(
        { err },
        "Slack auth.test failed after OAuth exchange; continuing with exchange metadata",
      );
    } else {
      throw err;
    }
  }

  const workspaceId = auth.team_id ?? payload.team?.id ?? null;
  if (!workspaceId) {
    throw new SlackApiError("Slack OAuth exchange did not return a workspace id", { status: 200 });
  }

  const scope = normalizeSlackScopes(payload.scope);
  const workspace: SlackWorkspaceMetadata = {
    workspaceId,
    workspaceName: auth.team ?? payload.team?.name ?? null,
    workspaceUrl: auth.url ?? null,
    enterpriseId: payload.enterprise?.id ?? null,
    enterpriseName: payload.enterprise?.name ?? null,
    botUserId: payload.bot_user_id ?? auth.user_id ?? null,
    installedByUserId: payload.authed_user?.id ?? null,
    scope,
  };

  return {
    accessToken,
    ...(typeof payload.refresh_token === "string" && payload.refresh_token.trim().length > 0
      ? { refreshToken: payload.refresh_token.trim() }
      : {}),
    ...(typeof payload.expires_in === "number" && payload.expires_in > 0
      ? { expiry: Date.now() + payload.expires_in * 1_000 }
      : {}),
    workspace,
    displayName: workspace.workspaceName ?? workspace.workspaceId,
  };
}

export async function listSlackChannels(accessToken: string): Promise<SlackChannelSummary[]> {
  const channels = new Map<string, SlackChannelSummary>();
  let cursor = "";
  let pageCount = 0;

  do {
    pageCount += 1;
    const payload = await callSlackFormApi<SlackConversationsListResponse>(
      accessToken,
      "conversations.list",
      {
        exclude_archived: "true",
        limit: "200",
        types: "public_channel",
        ...(cursor ? { cursor } : {}),
      },
    );

    for (const channel of payload.channels ?? []) {
      if (channel.is_archived) continue;
      // Defense-in-depth: API is restricted to public_channel, but skip any
      // private channels that may slip through (e.g. if scope ever widens).
      if (channel.is_private) continue;
      const id = typeof channel.id === "string" ? channel.id.trim() : "";
      const name = typeof channel.name === "string" ? channel.name.trim() : "";
      if (!id || !name) continue;

      const summary: SlackChannelSummary = {
        id,
        name,
        channelType: "public",
        isMember: Boolean(channel.is_member),
        memberCount:
          typeof channel.num_members === "number" && Number.isFinite(channel.num_members)
            ? channel.num_members
            : null,
      };

      channels.set(summary.id, summary);
    }

    cursor = payload.response_metadata?.next_cursor?.trim() ?? "";
  } while (cursor && pageCount < 20);

  if (cursor) {
    logger.warn({ remainingCursor: cursor }, "Slack channel list pagination truncated after 20 pages");
  }

  return [...channels.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function postSlackMessage(
  accessToken: string,
  input: {
    channelId: string;
    text: string;
    blocks?: Array<Record<string, unknown>>;
    threadTs?: string | null;
    clientMsgId?: string | null;
  },
): Promise<SlackMessagePostResult> {
  const payload = await callSlackJsonApi<SlackChatPostMessageResponse>(accessToken, "chat.postMessage", {
    channel: input.channelId,
    text: input.text,
    ...(input.blocks && input.blocks.length > 0 ? { blocks: input.blocks } : {}),
    ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    ...(input.clientMsgId ? { client_msg_id: input.clientMsgId } : {}),
    unfurl_links: false,
    unfurl_media: false,
  });

  const channel = typeof payload.channel === "string" ? payload.channel : input.channelId;
  const ts = typeof payload.ts === "string" ? payload.ts : null;
  if (!ts) {
    throw new SlackApiError("Slack chat.postMessage returned no message timestamp", { status: 200 });
  }
  return { channel, ts };
}

export function isRetryableSlackError(error: unknown): boolean {
  if (error instanceof SlackApiError) {
    if (error.status === 429) return true;
    if (error.status >= 500) return true;
    return error.slackError === "internal_error" || error.slackError === "fatal_error";
  }
  return error instanceof Error;
}

export async function waitForSlackRetry(error: unknown, attempt: number): Promise<void> {
  const retryAfterMs = error instanceof SlackApiError ? error.retryAfterMs : null;
  const backoffMs = retryAfterMs ?? Math.min(250 * (attempt + 1), 1_000);
  await new Promise((resolve) => setTimeout(resolve, backoffMs));
}
