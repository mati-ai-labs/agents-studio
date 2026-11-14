import type { Db } from "@paperclipai/db";
import { slackThreadBindings } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { connectorRegistryService } from "./connector-registry.js";
import {
  listSlackChannels,
  listSlackMembers,
  readSlackWorkspaceMetadata,
  resolveSlackTokenCompanyId,
  type SlackChannel,
  type SlackMember,
} from "./slack.js";

/**
 * Helpers for the agent-facing Slack tool: agents look up workspace members and
 * channels, then post a message that tags the people responsible. The bot token
 * never leaves the server.
 */

export const AGENT_SLACK_MAX_MENTIONS = 10;
export const AGENT_SLACK_MAX_TEXT_LENGTH = 3_000;
export const AGENT_SLACK_RATE_LIMIT = 20;
export const AGENT_SLACK_RATE_WINDOW_MS = 60 * 60 * 1_000;
const DIRECTORY_CACHE_TTL_MS = 10 * 60 * 1_000;

interface CacheEntry<T> {
  at: number;
  value: T;
}

const memberCache = new Map<string, CacheEntry<SlackMember[]>>();
const channelCache = new Map<string, CacheEntry<SlackChannel[]>>();
const sendLog = new Map<string, number[]>();

async function cached<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  load: () => Promise<T>,
  now: number,
  refresh: boolean,
): Promise<T> {
  const hit = cache.get(key);
  if (!refresh && hit && now - hit.at < DIRECTORY_CACHE_TTL_MS) return hit.value;
  const value = await load();
  cache.set(key, { at: now, value });
  return value;
}

export function getCachedSlackMembers(db: Db, companyId: string, opts: { refresh?: boolean; now?: number } = {}) {
  return cached(memberCache, companyId, () => listSlackMembers(db, companyId), opts.now ?? Date.now(), opts.refresh === true);
}

export function getCachedSlackChannels(db: Db, companyId: string, opts: { refresh?: boolean; now?: number } = {}) {
  return cached(channelCache, companyId, () => listSlackChannels(db, companyId), opts.now ?? Date.now(), opts.refresh === true);
}

/**
 * Sliding-window limit per agent. Returns the number of seconds to wait when the
 * agent is over the limit, or null when the send is allowed (and records it).
 */
export function takeAgentSlackSendSlot(agentKey: string, now = Date.now()): number | null {
  const recent = (sendLog.get(agentKey) ?? []).filter((at) => now - at < AGENT_SLACK_RATE_WINDOW_MS);
  if (recent.length >= AGENT_SLACK_RATE_LIMIT) {
    sendLog.set(agentKey, recent);
    return Math.max(1, Math.ceil((recent[0]! + AGENT_SLACK_RATE_WINDOW_MS - now) / 1_000));
  }
  recent.push(now);
  sendLog.set(agentKey, recent);
  return null;
}

/** Accepts a channel id (C…/G…), `#name` or `name`. */
export function resolveSlackChannel(channels: SlackChannel[], ref: string): SlackChannel | null {
  const trimmed = ref.trim();
  const byId = channels.find((channel) => channel.id === trimmed);
  if (byId) return byId;
  const name = trimmed.replace(/^#/, "").toLowerCase();
  return channels.find((channel) => channel.name.toLowerCase() === name) ?? null;
}

/** Bots can post to public channels without joining (chat:write.public); private channels need membership. */
export function canPostToSlackChannel(channel: SlackChannel): boolean {
  if (channel.isArchived) return false;
  return channel.isPrivate ? channel.isMember : true;
}

export function buildAgentSlackMessage(input: {
  text: string;
  mentionUserIds: string[];
  agentName?: string | null;
  issueIdentifier?: string | null;
  issueLink?: string | null;
}): string {
  const mentions = [...new Set(input.mentionUserIds)].map((id) => `<@${id}>`).join(" ");
  const body = input.text.trim();
  const footerParts = [
    input.agentName ? `_${input.agentName}_` : null,
    input.issueLink ? `<${input.issueLink}|${input.issueIdentifier ?? "issue"}>` : null,
  ].filter((part): part is string => Boolean(part));
  return [mentions ? `${mentions} ${body}` : body, footerParts.length ? `— ${footerParts.join(" · ")}` : null]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

/** Test hook: clears caches and rate-limit state. */
export function resetAgentSlackMessagingState() {
  memberCache.clear();
  channelCache.clear();
  sendLog.clear();
}

/**
 * Slack only delivers thread replies (message.channels) for public channels
 * the bot has joined. Private channels would need groups:history, which the
 * app does not request.
 */
export function slackChannelDeliversReplies(channel: SlackChannel): boolean {
  return !channel.isPrivate && channel.isMember && !channel.isArchived;
}

export type AgentSlackThreadBindingResult =
  | { status: "bound" | "already_bound"; bindingId: string; issueId: string }
  | { status: "bound_to_other_issue"; issueId: string }
  | { status: "skipped"; reason: string };

/**
 * Bind the Slack thread an agent just posted into (its own message, or the
 * root of the thread it replied in) to the issue, so replies in that thread
 * come back as issue comments through the normal inbound path. Never throws:
 * the Slack message is already out, so a failed binding must not fail the post.
 */
export async function bindAgentSlackThread(
  db: Db,
  input: { companyId: string; issueId: string; channel: SlackChannel; threadTs: string },
): Promise<AgentSlackThreadBindingResult> {
  try {
    const tokenCompanyId = await resolveSlackTokenCompanyId(db, input.companyId, input.channel.id);
    const connector = await connectorRegistryService(db).getByType(tokenCompanyId, "slack", null);
    if (!connector) return { status: "skipped", reason: "no Slack connector" };
    const workspace = readSlackWorkspaceMetadata(connector.config);
    if (!workspace) return { status: "skipped", reason: "Slack connector has no workspace metadata" };
    const now = new Date();
    const inserted = await db
      .insert(slackThreadBindings)
      .values({
        companyId: input.companyId,
        connectorId: connector.id,
        issueId: input.issueId,
        workspaceId: workspace.workspaceId,
        channelId: input.channel.id,
        channelName: input.channel.name,
        threadTs: input.threadTs,
        rootEventId: `agent_post:${workspace.workspaceId}:${input.channel.id}:${input.threadTs}`,
        source: "agent_post",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return { status: "bound", bindingId: inserted[0].id, issueId: input.issueId };
    const existing = await db
      .select()
      .from(slackThreadBindings)
      .where(and(
        eq(slackThreadBindings.workspaceId, workspace.workspaceId),
        eq(slackThreadBindings.channelId, input.channel.id),
        eq(slackThreadBindings.threadTs, input.threadTs),
      ))
      .then((rows) => rows[0] ?? null);
    if (!existing) return { status: "skipped", reason: "binding conflict" };
    if (existing.issueId === input.issueId) {
      return { status: "already_bound", bindingId: existing.id, issueId: existing.issueId };
    }
    return { status: "bound_to_other_issue", issueId: existing.issueId };
  } catch (error) {
    return { status: "skipped", reason: error instanceof Error ? error.message : String(error) };
  }
}
