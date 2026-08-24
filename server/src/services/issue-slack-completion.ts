import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, issues, slackThreadBindings } from "@paperclipai/db";
import type { IssueSlackCompletion, IssueWorkProduct } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { getPublicBaseUrl } from "../lib/public-url.js";
import { connectorRegistryService } from "./connector-registry.js";
import { workProductService } from "./work-products.js";
import { enqueueSlackOutbound } from "./slack-outbound-dispatch.js";
import {
  isRetryableSlackError,
  postSlackMessage,
  readSlackWorkspaceMetadata,
  waitForSlackRetry,
} from "./slack.js";

type IssueRow = typeof issues.$inferSelect;

function toIsoString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.toISOString();
}

function readIssueSlackCompletion(raw: unknown): IssueSlackCompletion | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const channelId = typeof record.channelId === "string" ? record.channelId.trim() : "";
  const channelName = typeof record.channelName === "string" ? record.channelName.trim() : "";
  const workspaceId = typeof record.workspaceId === "string" ? record.workspaceId.trim() : "";
  if (!channelId || !channelName || !workspaceId) return null;

  return {
    channelId,
    channelName,
    workspaceId,
    workspaceName: typeof record.workspaceName === "string" ? record.workspaceName : null,
    channelType: "public", // public-only — private channels not supported
    ...(typeof record.postAttemptCount === "number" && Number.isFinite(record.postAttemptCount)
      ? { postAttemptCount: record.postAttemptCount }
      : {}),
    ...(record.lastAttemptAt === null || typeof record.lastAttemptAt === "string"
      ? { lastAttemptAt: record.lastAttemptAt ?? null }
      : {}),
    ...(record.lastPostedAt === null || typeof record.lastPostedAt === "string"
      ? { lastPostedAt: record.lastPostedAt ?? null }
      : {}),
    ...(record.lastPostedCompletedAt === null || typeof record.lastPostedCompletedAt === "string"
      ? { lastPostedCompletedAt: record.lastPostedCompletedAt ?? null }
      : {}),
    ...(record.lastPostedMessageTs === null || typeof record.lastPostedMessageTs === "string"
      ? { lastPostedMessageTs: record.lastPostedMessageTs ?? null }
      : {}),
    ...(record.lastError === null || typeof record.lastError === "string"
      ? { lastError: record.lastError ?? null }
      : {}),
  };
}

function escapeSlackText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncateText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function formatWorkProductLine(product: IssueWorkProduct): string {
  const label = escapeSlackText(product.title);
  const statusSuffix =
    product.status && product.status !== "active" && product.status !== "ready_for_review"
      ? ` (${escapeSlackText(product.status)})`
      : "";
  return product.url
    ? `• <${product.url}|${label}>${statusSuffix}`
    : `• ${label}${statusSuffix}`;
}

function paperclipIssueUrl(issue: IssueRow, issuePrefix: string | null | undefined): string {
  const baseUrl = getPublicBaseUrl();
  const prefix = issuePrefix?.trim() || issue.identifier?.split("-")[0] || "PAP";
  const identifier = issue.identifier ?? issue.id;
  return `${baseUrl}/${encodeURIComponent(prefix)}/issues/${encodeURIComponent(identifier)}`;
}

export function buildIssueCompletionSlackMessage(input: {
  issue: IssueRow;
  slackCompletion: IssueSlackCompletion;
  completionComment?: string | null;
  workProducts: IssueWorkProduct[];
  issueUrl?: string | null;
}): { text: string; blocks: Array<Record<string, unknown>> } {
  const identifier = input.issue.identifier ? `${input.issue.identifier} ` : "";
  const workspaceName = input.slackCompletion.workspaceName ? ` in ${input.slackCompletion.workspaceName}` : "";
  const titleLine = `${identifier}${input.issue.title}`.trim();
  const trimmedComment = input.completionComment ? truncateText(input.completionComment, 1_500) : "";
  const visibleProducts = input.workProducts
    .filter((product) => product.status !== "archived")
    .slice(0, 5);

  const textParts = [
    `Paperclip issue ${titleLine} is done.`,
    input.issueUrl ? `Issue link: <${input.issueUrl}|Open in Paperclip>` : "",
    trimmedComment ? `Completion note: ${truncateText(trimmedComment, 280)}` : "",
    visibleProducts.length > 0 ? `Work products: ${visibleProducts.map((product) => product.title).join(", ")}` : "",
  ].filter(Boolean);

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Completed${workspaceName}:* ${input.issueUrl ? `<${input.issueUrl}|${escapeSlackText(titleLine)}>` : escapeSlackText(titleLine)}`,
      },
    },
  ];

  if (trimmedComment) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Completion note*\n${escapeSlackText(trimmedComment)}`,
      },
    });
  }

  if (visibleProducts.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Work products*\n${visibleProducts.map(formatWorkProductLine).join("\n")}`,
      },
    });
  }

  return {
    text: textParts.join(" "),
    blocks,
  };
}

/** Queue completion delivery; the worker performs the actual Slack API call. */
export async function enqueueIssueCompletionToSlack(
  db: Db,
  input: { issue: IssueRow; completionComment?: string | null },
): Promise<{ issue: IssueRow; queued: boolean; skippedReason?: string; error?: string }> {
  const completedAt = toIsoString(input.issue.completedAt);
  if (input.issue.status !== "done" || !completedAt) return { issue: input.issue, queued: false, skippedReason: "issue_not_done" };
  const configured = readIssueSlackCompletion(input.issue.slackCompletion);
  const connector = await connectorRegistryService(db).getByType(input.issue.companyId, "slack", null);
  if (!connector || connector.status !== "connected") return { issue: input.issue, queued: false, error: "Slack workspace is not connected for this company" };
  const workspace = readSlackWorkspaceMetadata(connector.config);
  const binding = await db.select().from(slackThreadBindings).where(eq(slackThreadBindings.issueId, input.issue.id)).then((rows) => rows[0] ?? null);
  const destination = binding ?? configured;
  if (!destination) return { issue: input.issue, queued: false, skippedReason: "no_slack_completion_config" };
  const lastPostedCompletedAt = configured?.lastPostedCompletedAt;
  if (lastPostedCompletedAt === completedAt) return { issue: input.issue, queued: false, skippedReason: "already_posted_for_completion" };
  const completion = configured ?? { channelId: binding!.channelId, channelName: binding!.channelName, workspaceId: binding!.workspaceId, workspaceName: workspace?.workspaceName ?? null, channelType: "public" as const, threadTs: binding!.threadTs };
  const products = await workProductService(db).listForIssue(input.issue.id).catch(() => []);
  const [company] = await db.select({ issuePrefix: companies.issuePrefix }).from(companies).where(eq(companies.id, input.issue.companyId)).limit(1);
  const message = buildIssueCompletionSlackMessage({ issue: input.issue, slackCompletion: completion, completionComment: input.completionComment, workProducts: products, issueUrl: paperclipIssueUrl(input.issue, company?.issuePrefix) });
  await enqueueSlackOutbound(db, { companyId: input.issue.companyId, connectorId: connector.id, issueId: input.issue.id, bindingId: binding?.id ?? null, kind: "completion", dedupeKey: `completion:issue:${input.issue.id}:${completedAt}`, channelId: destination.channelId, threadTs: binding?.threadTs ?? configured?.threadTs ?? null, payload: message });
  return { issue: input.issue, queued: true };
}

async function persistSlackCompletion(
  db: Db,
  issueId: string,
  slackCompletion: IssueSlackCompletion,
): Promise<IssueRow> {
  const [updated] = await db
    .update(issues)
    .set({
      slackCompletion,
      updatedAt: new Date(),
    })
    .where(eq(issues.id, issueId))
    .returning();

  if (!updated) {
    throw new Error(`Issue ${issueId} disappeared while updating Slack completion metadata`);
  }
  return updated;
}

export async function postIssueCompletionToSlack(
  db: Db,
  input: {
    issue: IssueRow;
    completionComment?: string | null;
  },
): Promise<{
    issue: IssueRow;
    posted: boolean;
    skippedReason?: string;
    error?: string;
  }> {
  const slackCompletion = readIssueSlackCompletion(input.issue.slackCompletion);
  if (!slackCompletion) {
    return { issue: input.issue, posted: false, skippedReason: "no_slack_completion_config" };
  }

  const completedAt = toIsoString(input.issue.completedAt);
  if (input.issue.status !== "done" || !completedAt) {
    return { issue: input.issue, posted: false, skippedReason: "issue_not_done" };
  }

  if (slackCompletion.lastPostedCompletedAt === completedAt) {
    return { issue: input.issue, posted: false, skippedReason: "already_posted_for_completion" };
  }

  const attemptTimestamp = new Date().toISOString();
  const nextAttemptCount = (slackCompletion.postAttemptCount ?? 0) + 1;
  const registry = connectorRegistryService(db);
  const connector = await registry.getByType(input.issue.companyId, "slack", null);
  const workspace = readSlackWorkspaceMetadata(connector?.config ?? null);

  const persistFailure = async (message: string) => {
    const updated = await persistSlackCompletion(db, input.issue.id, {
      ...slackCompletion,
      workspaceName: workspace?.workspaceName ?? slackCompletion.workspaceName ?? null,
      postAttemptCount: nextAttemptCount,
      lastAttemptAt: attemptTimestamp,
      lastError: message,
    });
    return { issue: updated, posted: false, error: message };
  };

  if (!connector || connector.status !== "connected") {
    return persistFailure("Slack workspace is not connected for this company");
  }

  if (workspace?.workspaceId && workspace.workspaceId !== slackCompletion.workspaceId) {
    return persistFailure("Selected Slack workspace is no longer connected");
  }

  const lookup = await registry.getCredentialsForAgentAsync(input.issue.companyId, "slack");
  if (!lookup) {
    return persistFailure("Slack credentials are unavailable for this company");
  }

  const products = await workProductService(db).listForIssue(input.issue.id).catch((error) => {
    logger.warn({ error, issueId: input.issue.id }, "failed to load work products for Slack completion message");
    return [];
  });
  const [company] = await db
    .select({ issuePrefix: companies.issuePrefix })
    .from(companies)
    .where(eq(companies.id, input.issue.companyId))
    .limit(1);
  const message = buildIssueCompletionSlackMessage({
    issue: input.issue,
    slackCompletion: {
      ...slackCompletion,
      workspaceName: workspace?.workspaceName ?? slackCompletion.workspaceName ?? null,
    },
    completionComment: input.completionComment,
    workProducts: products,
    issueUrl: paperclipIssueUrl(input.issue, company?.issuePrefix),
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const posted = await postSlackMessage(lookup.credentials.accessToken, {
        channelId: slackCompletion.channelId,
        text: message.text,
        blocks: message.blocks,
        threadTs: slackCompletion.threadTs ?? null,
      });

      const postedAt = new Date().toISOString();
      const updated = await persistSlackCompletion(db, input.issue.id, {
        ...slackCompletion,
        workspaceName: workspace?.workspaceName ?? slackCompletion.workspaceName ?? null,
        postAttemptCount: nextAttemptCount,
        lastAttemptAt: attemptTimestamp,
        lastPostedAt: postedAt,
        lastPostedCompletedAt: completedAt,
        lastPostedMessageTs: posted.ts,
        lastError: null,
      });

      return { issue: updated, posted: true };
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      const shouldRetry = attempt === 0 && isRetryableSlackError(error);

      logger.warn(
        {
          error: messageText,
          issueId: input.issue.id,
          companyId: input.issue.companyId,
          channelId: slackCompletion.channelId,
          attempt: attempt + 1,
          retrying: shouldRetry,
        },
        "failed to post Slack issue completion summary",
      );

      if (shouldRetry) {
        await waitForSlackRetry(error, attempt);
        continue;
      }

      return persistFailure(messageText);
    }
  }

  return persistFailure("Slack completion delivery exhausted retry budget");
}
