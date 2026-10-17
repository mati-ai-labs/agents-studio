import type { issues } from "@paperclipai/db";
import { getPublicBaseUrl } from "../lib/public-url.js";

type IssueRow = typeof issues.$inferSelect;

export function buildIssueLink(issue: Pick<IssueRow, "id" | "identifier">): string {
  const identifier = issue.identifier ?? issue.id;
  const prefix = issue.identifier?.split("-")[0] ?? "PAP";
  return `${getPublicBaseUrl()}/${encodeURIComponent(prefix)}/issues/${encodeURIComponent(identifier)}`;
}

export function buildSlackAckMessage(issue: Pick<IssueRow, "id" | "identifier"> & { assigneeName?: string | null }): string {
  const link = buildIssueLink(issue);
  return `Created <${link}|${issue.identifier ?? issue.id}> and assigned it to ${issue.assigneeName ?? "the configured agent"}.\nKeep replying in this Slack thread to add context.`;
}

// Agents sometimes post comment bodies as JSON string literals ("...\"x\"...").
// Unwrap those so Slack doesn't show stray quotes and backslashes.
export function normalizeAgentCommentBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed.trim();
    } catch {
      // Not valid JSON; fall through to the manual cleanup below.
    }
    return trimmed.slice(1, -1).replaceAll("\\\"", "\"").trim();
  }
  return trimmed.replaceAll("\\\"", "\"");
}

// Convert the common GitHub-flavored markdown agents write into Slack mrkdwn.
export function markdownToSlackMrkdwn(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "*$1*")
    .replace(/^#{1,6}\s+(.+?)\s*#*$/gm, "*$1*")
    .replace(/^(\s*)[-*]\s+/gm, "$1• ");
}

export function buildSlackProgressMessage(input: { issue: Pick<IssueRow, "id" | "identifier">; agentName?: string | null; body: string }): string {
  return markdownToSlackMrkdwn(normalizeAgentCommentBody(input.body)).slice(0, 3_000);
}

export function buildSlackErrorMessage(message: string): string {
  return `Paperclip Slack integration error: ${message.trim().slice(0, 1_000)}`;
}

export function buildSlackCompletionMessage(input: { issue: IssueRow; completionComment?: string | null }): string {
  const title = `${input.issue.identifier ?? input.issue.id} ${input.issue.title}`.trim();
  const link = buildIssueLink(input.issue);
  const note = input.completionComment?.trim();
  return [`Paperclip issue <${link}|${title}> is done.`, note ? `Completion note: ${note.slice(0, 1_500)}` : ""].filter(Boolean).join(" ");
}
