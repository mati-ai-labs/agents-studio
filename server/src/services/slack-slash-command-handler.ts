import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { slackChannelRoutes } from "@paperclipai/db";

export type SlackChannelMode = "triage" | "working" | "paused";
type SlackCommandMode = SlackChannelMode | "status";

export function parseSlackSlashCommand(text: string): { mode: SlackCommandMode } | { error: string } {
  const mode = text.trim().toLowerCase();
  if (!["triage", "working", "paused", "status"].includes(mode)) return { error: "Usage: /paperclip triage|working|paused|status" };
  return { mode: mode as SlackChannelMode };
}

export async function handleSlackSlashCommand(db: Db, input: { workspaceId: string; channelId: string; text: string }) {
  const parsed = parseSlackSlashCommand(input.text);
  if ("error" in parsed) return { response_type: "ephemeral" as const, text: parsed.error };
  const route = await db.select().from(slackChannelRoutes).where(and(eq(slackChannelRoutes.workspaceId, input.workspaceId), eq(slackChannelRoutes.channelId, input.channelId))).then((rows) => rows[0] ?? null);
  if (!route) return { response_type: "ephemeral" as const, text: "This Slack channel is not configured for Paperclip." };
  if (parsed.mode === "status") return { response_type: "ephemeral" as const, text: `Paperclip channel mode: ${route.mode ?? (route.enabled ? "triage" : "paused")}.` };
  const [updated] = await db.update(slackChannelRoutes).set({ mode: parsed.mode, enabled: parsed.mode !== "paused", updatedAt: new Date() }).where(eq(slackChannelRoutes.id, route.id)).returning();
  return { response_type: "ephemeral" as const, text: `Paperclip channel mode set to ${updated?.mode ?? parsed.mode}.` };
}
