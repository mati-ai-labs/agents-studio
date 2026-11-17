import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issueComments, issues, slackPolls, type SlackPoll, type SlackPollOption } from "@paperclipai/db";
import { heartbeatService } from "./heartbeat.js";
import { logActivity } from "./activity-log.js";
import { buildIssueLink } from "./slack-message-builder.js";
import { bindAgentSlackThread, type AgentSlackThreadBindingResult } from "./slack-agent-messaging.js";
import { getSlackUserName, postSlackMessage, updateSlackMessage, type SlackChannel } from "./slack.js";

/**
 * Agent polls in Slack. A poll is a Block Kit message with one button per
 * option. Clicks arrive at POST /api/connectors/slack/interactions, are stored
 * on the poll row, redraw the message with the tally, and come back to the
 * issue as a comment that wakes the assignee.
 */

export const SLACK_POLL_VOTE_ACTION_PREFIX = "paperclip_poll_vote";
export const SLACK_POLL_MIN_OPTIONS = 2;
export const SLACK_POLL_MAX_OPTIONS = 10;

export interface SlackPollResultOption {
  id: string;
  label: string;
  votes: number;
  voterIds: string[];
}

export interface SlackPollResults {
  pollId: string;
  status: string;
  question: string;
  multiSelect: boolean;
  channelId: string;
  channelName: string;
  messageTs: string | null;
  closesAt: string | null;
  closedAt: string | null;
  totalVoters: number;
  options: SlackPollResultOption[];
}

export function summarizeSlackPoll(poll: SlackPoll): SlackPollResults {
  const votes = poll.votes ?? {};
  const options = poll.options.map((option) => {
    const voterIds = Object.entries(votes)
      .filter(([, chosen]) => chosen.includes(option.id))
      .map(([userId]) => userId);
    return { id: option.id, label: option.label, votes: voterIds.length, voterIds };
  });
  return {
    pollId: poll.id,
    status: poll.status,
    question: poll.question,
    multiSelect: poll.multiSelect,
    channelId: poll.channelId,
    channelName: poll.channelName,
    messageTs: poll.messageTs,
    closesAt: poll.closesAt?.toISOString() ?? null,
    closedAt: poll.closedAt?.toISOString() ?? null,
    totalVoters: Object.values(votes).filter((chosen) => chosen.length > 0).length,
    options,
  };
}

function escapeSlackText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildSlackPollBlocks(
  poll: SlackPoll,
  context: { agentName?: string | null; issue?: { id: string; identifier: string | null } | null; mentionUserIds?: string[] } = {},
): Array<Record<string, unknown>> {
  const results = summarizeSlackPoll(poll);
  const open = poll.status === "open";
  const mentions = (context.mentionUserIds ?? []).map((id) => `<@${id}>`).join(" ");
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `${mentions ? `${mentions} ` : ""}:bar_chart: *${escapeSlackText(poll.question)}*` },
    },
  ];
  for (const option of results.options) {
    const voters = option.voterIds.map((id) => `<@${id}>`).join(" ");
    const tally = option.votes === 0 ? "_no votes_" : `*${option.votes}* ${option.votes === 1 ? "vote" : "votes"}: ${voters}`;
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*${escapeSlackText(option.label)}*\n${tally}` },
      ...(open
        ? {
          accessory: {
            type: "button",
            action_id: `${SLACK_POLL_VOTE_ACTION_PREFIX}:${option.id}`,
            value: `${poll.id}:${option.id}`,
            text: { type: "plain_text", text: "Vote", emoji: true },
          },
        }
        : {}),
    });
  }
  const footer = [
    open
      ? poll.multiSelect ? "Pick any. Click again to take a vote back." : "Pick one. Click again to take your vote back."
      : `Poll closed. ${results.totalVoters} ${results.totalVoters === 1 ? "person" : "people"} voted.`,
    open && poll.closesAt ? `Closes <!date^${Math.floor(poll.closesAt.getTime() / 1000)}^{date_short_pretty} {time}|${poll.closesAt.toISOString()}>.` : null,
    context.agentName ? `_${escapeSlackText(context.agentName)}_` : null,
    context.issue ? `<${buildIssueLink(context.issue)}|${context.issue.identifier ?? "issue"}>` : null,
  ].filter((part): part is string => Boolean(part));
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: footer.join(" · ") }] });
  return blocks;
}

function pollFallbackText(poll: SlackPoll): string {
  return `Poll: ${poll.question} (${poll.options.map((option) => option.label).join(" / ")})`;
}

export interface CreateSlackPollInput {
  companyId: string;
  issue: { id: string; identifier: string | null };
  agentId: string | null;
  agentName: string | null;
  channel: SlackChannel;
  question: string;
  options: string[];
  multiSelect: boolean;
  threadTs: string | null;
  mentionUserIds: string[];
  closesAt: Date | null;
}

export async function createSlackPoll(
  db: Db,
  input: CreateSlackPollInput,
): Promise<{ poll: SlackPoll; binding: AgentSlackThreadBindingResult }> {
  const options: SlackPollOption[] = input.options.map((label, index) => ({ id: String(index + 1), label }));
  const [inserted] = await db.insert(slackPolls).values({
    companyId: input.companyId,
    issueId: input.issue.id,
    createdByAgentId: input.agentId,
    channelId: input.channel.id,
    channelName: input.channel.name,
    threadTs: input.threadTs,
    question: input.question,
    options,
    multiSelect: input.multiSelect,
    closesAt: input.closesAt,
  }).returning();
  if (!inserted) throw new Error("Slack poll was not created");

  let posted: Awaited<ReturnType<typeof postSlackMessage>>;
  try {
    posted = await postSlackMessage(db, input.companyId, {
      channelId: input.channel.id,
      text: pollFallbackText(inserted),
      blocks: buildSlackPollBlocks(inserted, { agentName: input.agentName, issue: input.issue, mentionUserIds: input.mentionUserIds }),
      threadTs: input.threadTs,
    });
  } catch (error) {
    await db.delete(slackPolls).where(eq(slackPolls.id, inserted.id));
    throw error;
  }

  const [poll] = await db.update(slackPolls)
    .set({ messageTs: posted.messageTs, updatedAt: new Date() })
    .where(eq(slackPolls.id, inserted.id))
    .returning();
  const rootTs = input.threadTs ?? posted.messageTs;
  const binding: AgentSlackThreadBindingResult = rootTs
    ? await bindAgentSlackThread(db, { companyId: input.companyId, issueId: input.issue.id, channel: input.channel, threadTs: rootTs })
    : { status: "skipped", reason: "missing_message_ts" };
  return { poll: poll ?? inserted, binding };
}

async function loadPollContext(db: Db, poll: SlackPoll) {
  const issue = await db
    .select({ id: issues.id, identifier: issues.identifier, assigneeAgentId: issues.assigneeAgentId, status: issues.status })
    .from(issues)
    .where(and(eq(issues.id, poll.issueId), eq(issues.companyId, poll.companyId)))
    .then((rows) => rows[0] ?? null);
  const agentName = poll.createdByAgentId
    ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, poll.createdByAgentId)).then((rows) => rows[0]?.name ?? null)
    : null;
  return { issue, agentName };
}

async function redrawPoll(
  db: Db,
  poll: SlackPoll,
  context: { issue: { id: string; identifier: string | null } | null; agentName: string | null },
) {
  if (!poll.messageTs) return;
  await updateSlackMessage(db, poll.companyId, {
    channelId: poll.channelId,
    ts: poll.messageTs,
    text: pollFallbackText(poll),
    blocks: buildSlackPollBlocks(poll, context),
  });
}

function formatResultsMarkdown(results: SlackPollResults, names: Map<string, string>): string {
  return results.options
    .map((option) => {
      const voters = option.voterIds.map((id) => names.get(id) ?? id).join(", ");
      return `- **${option.label}**: ${option.votes}${voters ? ` (${voters})` : ""}`;
    })
    .join("\n");
}

async function voterNames(db: Db, poll: SlackPoll): Promise<Map<string, string>> {
  const ids = Object.keys(poll.votes ?? {});
  const names = new Map<string, string>();
  for (const id of ids) {
    names.set(id, (await getSlackUserName(db, poll.companyId, id, { channelId: poll.channelId })) ?? id);
  }
  return names;
}

async function commentAndWake(
  db: Db,
  poll: SlackPoll,
  issue: { id: string; assigneeAgentId: string | null; status: string },
  input: { body: string; externalId: string; externalAuthorId: string | null; reason: string; pluginWorkerManager?: unknown },
) {
  const reopened = issue.status === "done" || issue.status === "cancelled";
  const comment = await db.transaction(async (tx) => {
    if (reopened) await tx.update(issues).set({ status: "todo", completedAt: null, cancelledAt: null, updatedAt: new Date() }).where(eq(issues.id, issue.id));
    const [created] = await tx.insert(issueComments).values({
      companyId: poll.companyId,
      issueId: issue.id,
      authorType: "system",
      authorAgentId: null,
      authorUserId: null,
      body: input.body.slice(0, 30_000),
      externalSource: "slack",
      externalId: input.externalId,
      externalAuthorId: input.externalAuthorId,
    }).onConflictDoNothing().returning();
    await tx.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, issue.id));
    return created ?? null;
  });
  if (!comment || !issue.assigneeAgentId) return comment;
  const heartbeat = heartbeatService(db, { pluginWorkerManager: input.pluginWorkerManager as never });
  void heartbeat.wakeup(issue.assigneeAgentId, {
    source: "automation",
    triggerDetail: "system",
    reason: reopened ? "issue_reopened_via_slack" : "issue_commented",
    payload: { issueId: issue.id, commentId: comment.id, slackPollId: poll.id, mutation: input.reason },
    requestedByActorType: "system",
    requestedByActorId: "slack",
    contextSnapshot: {
      issueId: issue.id,
      taskId: issue.id,
      commentId: comment.id,
      wakeCommentId: comment.id,
      source: "slack.poll",
      wakeReason: reopened ? "issue_reopened_via_slack" : "issue_commented",
      slackPoll: { pollId: poll.id, channelId: poll.channelId, messageTs: poll.messageTs },
    },
  }).catch(() => {});
  return comment;
}

export type SlackPollVoteResult =
  | { status: "recorded"; poll: SlackPoll; chosen: string[] }
  | { status: "closed"; poll: SlackPoll }
  | { status: "not_found" | "unknown_option" | "message_mismatch" };

/** Record (or toggle off) one Slack user's click on a poll option. */
export async function recordSlackPollVote(
  db: Db,
  input: { pollId: string; optionId: string; slackUserId: string; channelId: string | null; messageTs: string | null; pluginWorkerManager?: unknown },
): Promise<SlackPollVoteResult> {
  const outcome = await db.transaction(async (tx) => {
    const poll = await tx.select().from(slackPolls).where(eq(slackPolls.id, input.pollId)).for("update").then((rows) => rows[0] ?? null);
    if (!poll) return { status: "not_found" as const };
    if ((input.channelId && input.channelId !== poll.channelId) || (input.messageTs && poll.messageTs && input.messageTs !== poll.messageTs)) {
      return { status: "message_mismatch" as const };
    }
    if (poll.status !== "open") return { status: "closed" as const, poll };
    if (poll.closesAt && poll.closesAt.getTime() <= Date.now()) return { status: "expired" as const, poll };
    if (!poll.options.some((option) => option.id === input.optionId)) return { status: "unknown_option" as const };

    const current = poll.votes?.[input.slackUserId] ?? [];
    const chosen = current.includes(input.optionId)
      ? current.filter((id) => id !== input.optionId)
      : poll.multiSelect ? [...current, input.optionId] : [input.optionId];
    const votes = { ...(poll.votes ?? {}) };
    if (chosen.length > 0) votes[input.slackUserId] = chosen;
    else delete votes[input.slackUserId];
    const [updated] = await tx.update(slackPolls).set({ votes, updatedAt: new Date() }).where(eq(slackPolls.id, poll.id)).returning();
    return { status: "recorded" as const, poll: updated ?? poll, chosen };
  });

  if (outcome.status === "expired") {
    const closed = await closeSlackPoll(db, outcome.poll.id, { reason: "expired", pluginWorkerManager: input.pluginWorkerManager });
    return { status: "closed", poll: closed ?? outcome.poll };
  }
  if (outcome.status !== "recorded") return outcome;

  const { poll, chosen } = outcome;
  const context = await loadPollContext(db, poll);
  const { issue } = context;
  await redrawPoll(db, poll, context).catch(() => {});
  if (issue) {
    const voter = (await getSlackUserName(db, poll.companyId, input.slackUserId, { channelId: poll.channelId })) ?? input.slackUserId;
    const labels = chosen.map((id) => poll.options.find((option) => option.id === id)?.label ?? id);
    const results = summarizeSlackPoll(poll);
    const names = await voterNames(db, poll);
    const body = [
      `From Slack user ${voter} (poll vote):`,
      labels.length > 0 ? `Voted **${labels.join(", ")}** on "${poll.question}".` : `Took back their vote on "${poll.question}".`,
      "",
      `Current results (${results.totalVoters} ${results.totalVoters === 1 ? "voter" : "voters"}, poll \`${poll.id}\`):`,
      formatResultsMarkdown(results, names),
    ].join("\n");
    await commentAndWake(db, poll, issue, {
      body,
      externalId: `poll:${poll.id}:${input.slackUserId}:${randomUUID()}`,
      externalAuthorId: input.slackUserId,
      reason: "slack_poll_vote",
      pluginWorkerManager: input.pluginWorkerManager,
    });
    await logActivity(db, {
      companyId: poll.companyId,
      actorType: "system",
      actorId: "slack",
      action: "slack.poll_voted",
      entityType: "issue",
      entityId: issue.id,
      details: { pollId: poll.id, slackUserId: input.slackUserId, chosen },
    });
  }
  return { status: "recorded", poll, chosen };
}

/** Close a poll: stop accepting votes, redraw it without buttons, post the final results on the issue. */
export async function closeSlackPoll(
  db: Db,
  pollId: string,
  options: { reason?: "agent" | "expired"; closedByAgentId?: string | null; pluginWorkerManager?: unknown } = {},
): Promise<SlackPoll | null> {
  const [poll] = await db.update(slackPolls)
    .set({ status: "closed", closedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(slackPolls.id, pollId), eq(slackPolls.status, "open")))
    .returning();
  if (!poll) return db.select().from(slackPolls).where(eq(slackPolls.id, pollId)).then((rows) => rows[0] ?? null);

  const context = await loadPollContext(db, poll);
  const { issue } = context;
  await redrawPoll(db, poll, context).catch(() => {});
  if (issue) {
    const results = summarizeSlackPoll(poll);
    const names = await voterNames(db, poll);
    const body = [
      `Slack poll closed${options.reason === "expired" ? " (time ran out)" : ""}: "${poll.question}"`,
      `${results.totalVoters} ${results.totalVoters === 1 ? "person" : "people"} voted (poll \`${poll.id}\`).`,
      "",
      formatResultsMarkdown(results, names),
    ].join("\n");
    // An agent closing its own poll already knows the result; only wake on expiry.
    if (options.reason === "expired") {
      await commentAndWake(db, poll, issue, {
        body,
        externalId: `poll:${poll.id}:closed`,
        externalAuthorId: null,
        reason: "slack_poll_closed",
        pluginWorkerManager: options.pluginWorkerManager,
      });
    } else {
      await db.insert(issueComments).values({
        companyId: poll.companyId,
        issueId: issue.id,
        authorType: options.closedByAgentId ? "agent" : "system",
        authorAgentId: options.closedByAgentId ?? null,
        authorUserId: null,
        body,
        externalSource: "slack",
        externalId: `poll:${poll.id}:closed`,
      }).onConflictDoNothing();
    }
    await logActivity(db, {
      companyId: poll.companyId,
      actorType: options.closedByAgentId ? "agent" : "system",
      actorId: options.closedByAgentId ?? "slack",
      agentId: options.closedByAgentId ?? null,
      action: "slack.poll_closed",
      entityType: "issue",
      entityId: issue.id,
      details: { pollId: poll.id, reason: options.reason ?? "agent", totalVoters: results.totalVoters },
    });
  }
  return poll;
}

/** Read a poll, closing it first if its deadline has passed. */
export async function getSlackPoll(
  db: Db,
  companyId: string,
  pollId: string,
  options: { pluginWorkerManager?: unknown } = {},
): Promise<SlackPoll | null> {
  const poll = await db.select().from(slackPolls)
    .where(and(eq(slackPolls.id, pollId), eq(slackPolls.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (poll && poll.status === "open" && poll.closesAt && poll.closesAt.getTime() <= Date.now()) {
    return closeSlackPoll(db, poll.id, { reason: "expired", pluginWorkerManager: options.pluginWorkerManager });
  }
  return poll;
}

export async function listSlackPollsForIssue(db: Db, companyId: string, issueId: string): Promise<SlackPoll[]> {
  return db.select().from(slackPolls)
    .where(and(eq(slackPolls.companyId, companyId), eq(slackPolls.issueId, issueId)));
}
