import { and, eq, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, slackEventDeliveries, slackOutboundDeliveries } from "@paperclipai/db";
import { connectorRegistryService } from "./connector-registry.js";
import { isRetryableSlackError, postSlackMessage, SlackApiError } from "./slack.js";
import { slackInboundHandler } from "./slack-inbound-handler.js";
import { logActivity } from "./activity-log.js";

const STALE_LEASE_MS = 5 * 60_000;
const OUTBOUND_MAX_ATTEMPTS = 8;
const INBOUND_MAX_ATTEMPTS = 10;

function backoff(attempt: number): Date {
  const delays = [1_000, 5_000, 30_000, 120_000, 600_000];
  const base = delays[Math.min(attempt - 1, delays.length - 1)] ?? Math.min(600_000, 2 ** attempt * 1_000);
  return new Date(Date.now() + base + Math.floor(Math.random() * 500));
}

export function createSlackDeliveryWorker(db: Db, options: { pluginWorkerManager?: unknown; intervalMs?: number } = {}) {
  const inbound = slackInboundHandler(db, options);
  const registry = connectorRegistryService(db);
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function claimInbound() {
    const stale = new Date(Date.now() - STALE_LEASE_MS);
    const rows = await db.select().from(slackEventDeliveries).where(and(
      lte(slackEventDeliveries.nextAttemptAt, new Date()),
      or(eq(slackEventDeliveries.status, "pending"), and(eq(slackEventDeliveries.status, "processing"), lte(slackEventDeliveries.processingStartedAt, stale))),
    )).limit(20);
    const claimed = [];
    for (const row of rows) {
      const [next] = await db.update(slackEventDeliveries).set({ status: "processing", attemptCount: row.attemptCount + 1, processingStartedAt: new Date(), updatedAt: new Date() }).where(and(eq(slackEventDeliveries.id, row.id), or(eq(slackEventDeliveries.status, "pending"), eq(slackEventDeliveries.status, "processing")))).returning();
      if (next) claimed.push(next);
    }
    return claimed;
  }

  async function claimOutbound() {
    const stale = new Date(Date.now() - STALE_LEASE_MS);
    const rows = await db.select().from(slackOutboundDeliveries).where(and(
      lte(slackOutboundDeliveries.nextAttemptAt, new Date()),
      or(eq(slackOutboundDeliveries.status, "pending"), and(eq(slackOutboundDeliveries.status, "processing"), lte(slackOutboundDeliveries.processingStartedAt, stale))),
    )).limit(20);
    const claimed = [];
    for (const row of rows) {
      const [next] = await db.update(slackOutboundDeliveries).set({ status: "processing", attemptCount: row.attemptCount + 1, processingStartedAt: new Date(), updatedAt: new Date() }).where(and(eq(slackOutboundDeliveries.id, row.id), or(eq(slackOutboundDeliveries.status, "pending"), eq(slackOutboundDeliveries.status, "processing")))).returning();
      if (next) claimed.push(next);
    }
    return claimed;
  }

  async function processOutbound(row: typeof slackOutboundDeliveries.$inferSelect) {
    const connector = await registry.getById(row.connectorId);
    const credentials = await registry.getCredentialsForAgentAsync(row.companyId, "slack");
    const payload = row.payload as { text?: string; blocks?: Array<Record<string, unknown>> } | null;
    if (!connector || connector.status !== "connected" || !credentials || !payload?.text) {
      await db.update(slackOutboundDeliveries).set({ status: "failed", lastError: "Slack connector or delivery payload unavailable", updatedAt: new Date() }).where(eq(slackOutboundDeliveries.id, row.id));
      return;
    }
    try {
      const sent = await postSlackMessage(credentials.credentials.accessToken, { channelId: row.channelId, text: payload.text, blocks: payload.blocks, threadTs: row.threadTs, clientMsgId: row.id });
      await db.update(slackOutboundDeliveries).set({ status: "sent", sentAt: new Date(), slackMessageTs: sent.ts, lastError: null, updatedAt: new Date() }).where(eq(slackOutboundDeliveries.id, row.id));
      if (row.kind === "completion") {
        const issue = await db.select().from(issues).where(eq(issues.id, row.issueId)).then((rows) => rows[0] ?? null);
        const current = issue?.slackCompletion;
        if (issue && current) await db.update(issues).set({ slackCompletion: { ...current, postAttemptCount: (current.postAttemptCount ?? 0) + 1, lastAttemptAt: new Date().toISOString(), lastPostedAt: new Date().toISOString(), lastPostedCompletedAt: issue.completedAt instanceof Date ? issue.completedAt.toISOString() : issue.completedAt, lastPostedMessageTs: sent.ts, lastError: null }, updatedAt: new Date() }).where(eq(issues.id, issue.id));
        await logActivity(db, { companyId: row.companyId, actorType: "system", actorId: "slack", action: "issue.slack_completion_posted", entityType: "issue", entityId: row.issueId, details: { deliveryId: row.id, messageTs: sent.ts } });
      }
    } catch (error) {
      const retry = isRetryableSlackError(error) && row.attemptCount < OUTBOUND_MAX_ATTEMPTS;
      if (error instanceof SlackApiError && ["invalid_auth", "account_inactive", "token_revoked"].includes(error.slackError ?? "")) await registry.setError(row.companyId, "slack", error.slackError ?? "Slack authentication failed");
      await db.update(slackOutboundDeliveries).set({ status: retry ? "pending" : "failed", nextAttemptAt: retry ? backoff(row.attemptCount) : row.nextAttemptAt, lastError: error instanceof Error ? error.message : String(error), updatedAt: new Date() }).where(eq(slackOutboundDeliveries.id, row.id));
      if (row.kind === "completion" && !retry) await logActivity(db, { companyId: row.companyId, actorType: "system", actorId: "slack", action: "issue.slack_completion_failed", entityType: "issue", entityId: row.issueId, details: { deliveryId: row.id, error: error instanceof Error ? error.message : String(error) } });
    }
  }

  async function processOnce() {
    if (running) return;
    running = true;
    try {
      const inboundRows = await claimInbound();
      for (const row of inboundRows) {
        try { await inbound.process(row); } catch (error) {
          const retry = row.attemptCount < INBOUND_MAX_ATTEMPTS;
          await db.update(slackEventDeliveries).set({ status: retry ? "pending" : "failed", nextAttemptAt: retry ? backoff(row.attemptCount) : row.nextAttemptAt, lastError: error instanceof Error ? error.message : String(error), updatedAt: new Date() }).where(eq(slackEventDeliveries.id, row.id));
        }
      }
      const outboundRows = await claimOutbound();
      for (const row of outboundRows) await processOutbound(row);
    } finally { running = false; }
  }

  function start() { if (timer) return; timer = setInterval(() => void processOnce(), options.intervalMs ?? 1_000); timer.unref?.(); void processOnce(); }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { start, stop, kick: () => void processOnce(), processOnce };
}
