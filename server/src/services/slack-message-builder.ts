import type { IssueSlackCompletion } from "@paperclipai/shared";
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

export function buildSlackProgressMessage(input: { issue: Pick<IssueRow, "id" | "identifier">; agentName?: string | null; body: string }): string {
  return `${input.agentName ?? "Agent"} update on <${buildIssueLink(input.issue)}|${input.issue.identifier ?? input.issue.id}>:\n${input.body.trim().slice(0, 3_000)}`;
}

export function buildSlackErrorMessage(message: string): string {
  return `Paperclip Slack integration error: ${message.trim().slice(0, 1_000)}`;
}

export function buildSlackCompletionMessage(input: { issue: IssueRow; completionComment?: string | null; slackCompletion?: IssueSlackCompletion | null }): string {
  const title = `${input.issue.identifier ?? input.issue.id} ${input.issue.title}`.trim();
  const link = buildIssueLink(input.issue);
  const note = input.completionComment?.trim();
  return [`Paperclip issue <${link}|${title}> is done.`, note ? `Completion note: ${note.slice(0, 1_500)}` : ""].filter(Boolean).join(" ");
}
