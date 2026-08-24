import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";
import { issueService } from "./issues.js";

export interface SlackIssueIngestInput {
  companyId: string;
  assigneeAgentId: string;
  workspaceId: string;
  channelId: string;
  channelName: string;
  threadTs: string;
  eventId: string;
  userId: string;
  text: string;
}

function stripMention(text: string): string {
  return text.replace(/<@[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export async function ingestSlackIssue(db: Db, input: SlackIssueIngestInput) {
  const originId = `${input.workspaceId}:${input.channelId}:${input.threadTs}`;
  const existing = await db.select().from(issues).where(eq(issues.originId, originId)).then((rows) => rows.find((row) => row.companyId === input.companyId) ?? null);
  if (existing) return existing;
  const body = stripMention(input.text);
  const title = (body.split("\n")[0]?.trim() || `Slack request from ${input.userId}`).slice(0, 160);
  const description = `${body.slice(0, 30_000)}\n\nSource: Slack ${input.workspaceId}/${input.channelId}/${input.threadTs}`.trim();
  try {
    return await issueService(db).create(input.companyId, {
      title,
      description,
      status: "todo",
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId,
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      originKind: "slack_thread",
      originId,
      originFingerprint: input.eventId,
      slackCompletion: {
        workspaceId: input.workspaceId,
        workspaceName: null,
        channelId: input.channelId,
        channelName: input.channelName,
        channelType: "public",
        threadTs: input.threadTs,
      },
    });
  } catch (error) {
    const raced = await db.select().from(issues).where(eq(issues.originId, originId)).then((rows) => rows.find((row) => row.companyId === input.companyId) ?? null);
    if (raced) return raced;
    throw error;
  }
}

export async function slackAssigneeName(db: Db, agentId: string): Promise<string | null> {
  return db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]?.name ?? null);
}
