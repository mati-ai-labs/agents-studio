import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { slackOutboundDeliveries, slackThreadBindings } from "@paperclipai/db";

export interface EnqueueSlackOutboundInput {
  companyId: string;
  connectorId: string;
  issueId: string;
  bindingId?: string | null;
  commentId?: string | null;
  kind: "acknowledgement" | "progress" | "completion" | "error";
  dedupeKey: string;
  channelId: string;
  threadTs?: string | null;
  payload?: { text: string; blocks?: Array<Record<string, unknown>> } | null;
}

export async function enqueueSlackOutbound(db: Db, input: EnqueueSlackOutboundInput) {
  const [row] = await db.insert(slackOutboundDeliveries).values({
    companyId: input.companyId,
    connectorId: input.connectorId,
    issueId: input.issueId,
    bindingId: input.bindingId ?? null,
    commentId: input.commentId ?? null,
    kind: input.kind,
    dedupeKey: input.dedupeKey,
    channelId: input.channelId,
    threadTs: input.threadTs ?? null,
    payload: input.payload ?? null,
  }).onConflictDoNothing({ target: [slackOutboundDeliveries.connectorId, slackOutboundDeliveries.dedupeKey] }).returning();
  if (row) return row;
  return db.select().from(slackOutboundDeliveries).where(and(
    eq(slackOutboundDeliveries.connectorId, input.connectorId),
    eq(slackOutboundDeliveries.dedupeKey, input.dedupeKey),
  )).then((rows) => rows[0] ?? null);
}

export async function enqueueSlackOutboundForBinding(db: Db, input: Omit<EnqueueSlackOutboundInput, "companyId" | "connectorId" | "bindingId" | "channelId" | "threadTs"> & { bindingId: string }) {
  const binding = await db.select().from(slackThreadBindings).where(eq(slackThreadBindings.id, input.bindingId)).then((rows) => rows[0] ?? null);
  if (!binding) return null;
  return enqueueSlackOutbound(db, {
    ...input,
    companyId: binding.companyId,
    connectorId: binding.connectorId,
    bindingId: binding.id,
    channelId: binding.channelId,
    threadTs: binding.threadTs,
  });
}
