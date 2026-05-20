import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { chatSessions, chatMessages, heartbeatRuns } from "@paperclipai/db";
import { and, desc, eq, gte } from "drizzle-orm";
import { agentService, heartbeatService, subscribeCompanyLiveEvents } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";
import { logger } from "../middleware/logger.js";
import { buildHeartbeatRunIssueComment } from "../services/heartbeat-run-summary.js";

export function chatRoutes(db: Db) {
  const router = Router();
  const agentsSvc = agentService(db);
  const heartbeat = heartbeatService(db);

  // ── helpers ────────────────────────────────────────────────────────────────

  async function resolveCeoAgent(companyId: string) {
    const agents = await agentsSvc.list(companyId);
    const ceos = agents.filter((a) => a.role === "ceo");
    return ceos.find((a) => a.status !== "paused") ?? ceos[0] ?? null;
  }

  async function buildChatSession(session: typeof chatSessions.$inferSelect) {
    const messages = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, session.id))
      .orderBy(chatMessages.createdAt);
    return { ...session, messages };
  }

  async function readRunReply(
    runId: string,
    timeoutMs = 8_000,
  ) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const [run] = await db
        .select({ resultJson: heartbeatRuns.resultJson })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .limit(1);

      const reply = buildHeartbeatRunIssueComment(
        (run?.resultJson ?? null) as Record<string, unknown> | null,
      );
      if (reply) {
        return reply;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
  }

  async function readSessionRunReplySince(
    companyId: string,
    sessionId: string,
    agentId: string,
    since: Date,
    timeoutMs = 90_000,
  ) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const runs = await db
        .select({
          id: heartbeatRuns.id,
          resultJson: heartbeatRuns.resultJson,
          contextSnapshot: heartbeatRuns.contextSnapshot,
          status: heartbeatRuns.status,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.agentId, agentId),
            gte(heartbeatRuns.createdAt, since),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(10);

      for (const run of runs) {
        if (!["succeeded", "failed", "cancelled", "timed_out"].includes(run.status)) continue;
        const context = (run.contextSnapshot ?? {}) as Record<string, unknown>;
        if (context.taskSource !== "ceo_chat") continue;
        if (context.chatSessionId !== sessionId) continue;
        const reply = buildHeartbeatRunIssueComment(
          (run.resultJson ?? null) as Record<string, unknown> | null,
        );
        if (reply) return reply;
      }

      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return null;
  }

  // ── POST /api/chat/sessions ─────────────────────────────────────────────

  router.post("/companies/:companyId/chat/sessions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const title =
      typeof req.body?.title === "string" && req.body.title.trim().length > 0
        ? req.body.title.trim()
        : "New Chat";

    const [session] = await db
      .insert(chatSessions)
      .values({ companyId, title, status: "active" })
      .returning();

    res.status(201).json(session);
  });

  // ── GET /api/chat/sessions ──────────────────────────────────────────────

  router.get("/companies/:companyId/chat/sessions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const sessions = await db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.companyId, companyId))
      .orderBy(desc(chatSessions.updatedAt));

    res.json(sessions);
  });

  // ── GET /api/chat/sessions/:id ───────────────────────────────────────────

  router.get("/chat/sessions/:id", async (req, res) => {
    const id = req.params.id as string;
    const [session] = await db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, id))
      .limit(1);

    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    assertCompanyAccess(req, session.companyId);
    const full = await buildChatSession(session);
    res.json(full);
  });

  // ── DELETE /api/chat/sessions/:id ────────────────────────────────────────

  router.delete("/chat/sessions/:id", async (req, res) => {
    const id = req.params.id as string;
    const [session] = await db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, id))
      .limit(1);

    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    assertCompanyAccess(req, session.companyId);
    await db.delete(chatSessions).where(eq(chatSessions.id, id));
    res.json({ ok: true });
  });

  // ── POST /api/chat/sessions/:id/messages ─────────────────────────────────
  // Direct chat to CEO.
  // - Session-scoped run identity via taskKey (no hidden issue dependency)
  // - Agent memory remains session-native through adapter runtime session reuse

  router.post("/chat/sessions/:id/messages", async (req, res) => {
    const sessionId = req.params.id as string;

    const [session] = await db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);

    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    assertCompanyAccess(req, session.companyId);

    const content =
      typeof req.body?.content === "string" && req.body.content.trim().length > 0
        ? req.body.content.trim()
        : null;

    if (!content) {
      res.status(422).json({ error: "Message content is required" });
      return;
    }

    // Save user message
    const [userMsg] = await db
      .insert(chatMessages)
      .values({ sessionId, role: "user", content })
      .returning();

    await db
      .update(chatSessions)
      .set({ updatedAt: new Date() })
      .where(eq(chatSessions.id, sessionId));

    // Set SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    res.write(": connected\n\n");
    res.write(`event: message\ndata: ${JSON.stringify(userMsg)}\n\n`);

    // Find the CEO agent
    const ceoAgent = await resolveCeoAgent(session.companyId);

    if (!ceoAgent) {
      const noCeo = "No CEO agent found. Please configure a CEO agent first.";
      const [asstMsg] = await db
        .insert(chatMessages)
        .values({ sessionId, role: "assistant", content: noCeo })
        .returning();
      res.write(`event: message\ndata: ${JSON.stringify(asstMsg)}\n\n`);
      res.write("event: done\ndata: {}\n\n");
      res.end();
      return;
    }

    // Note: We do NOT pass chat history to CEO. Claude Code manages its own memory
    // via MEMORY.md files in its workspace. Passing raw history would fight against
    // Claude Code's native memory architecture.

    const requestStartedAt = new Date();
    let responseFinished = false;
    let ceoRunId: string | null = null;
    let queuedWithoutRunId = false;
    let completionTimer: NodeJS.Timeout | null = null;

    const sendStatus = (status: string, message: string, extra?: Record<string, unknown>) => {
      if (responseFinished || !res.writable) return;
      res.write(`event: status\ndata: ${JSON.stringify({ status, message, ...(extra ?? {}) })}\n\n`);
    };

    const finishWithAssistant = async (content: string) => {
      if (responseFinished || !res.writable) return;
      responseFinished = true;
      if (completionTimer) clearTimeout(completionTimer);
      const [asstMsg] = await db
        .insert(chatMessages)
        .values({ sessionId, role: "assistant", content })
        .returning();
      res.write(`event: message\ndata: ${JSON.stringify(asstMsg)}\n\n`);
      res.write("event: done\ndata: {}\n\n");
      res.end();
    };
    completionTimer = setTimeout(() => {
      if (responseFinished) return;
      void finishWithAssistant(
        "Still queued/running. Request remains active; send another message to check latest status.",
      );
    }, 180_000);

    const unsubscribe = subscribeCompanyLiveEvents(session.companyId, (event) => {
      if (responseFinished || !res.writable) return;

      if (event.type === "heartbeat.run.queued") {
        const payload = event.payload as Record<string, unknown>;
        const runId = payload.runId as string | undefined;
        if (!runId) return;
        if (ceoRunId === runId) {
          sendStatus("queued", "Request queued for CEO execution.", { runId });
          return;
        }
        if (!queuedWithoutRunId) return;
        void (async () => {
          try {
            const [run] = await db
              .select({
                id: heartbeatRuns.id,
                agentId: heartbeatRuns.agentId,
                contextSnapshot: heartbeatRuns.contextSnapshot,
              })
              .from(heartbeatRuns)
              .where(eq(heartbeatRuns.id, runId))
              .limit(1);

            const context = (run?.contextSnapshot ?? {}) as Record<string, unknown>;
            const chatSessionId = typeof context.chatSessionId === "string" ? context.chatSessionId : null;
            if (!run || run.agentId !== ceoAgent.id || chatSessionId !== sessionId) return;
            if (context.taskSource !== "ceo_chat") return;

            ceoRunId = run.id;
            queuedWithoutRunId = false;
            sendStatus("queued", "Queued and waiting for CEO execution slot.", { runId: run.id });
          } catch (err) {
            logger.warn({ err, runId }, "Failed to resolve queued CEO chat run");
          }
        })();
      }

      if (event.type === "heartbeat.run.status") {
        const payload = event.payload as Record<string, unknown>;
        const runId = payload.runId as string | undefined;
        if (runId !== ceoRunId) return;

        const status = payload.status as string | undefined;
        if (status === "running") {
          sendStatus("running", "CEO is working on your request.", { runId });
          return;
        }
        if (status && ["succeeded", "failed", "cancelled", "timed_out"].includes(status)) {
          if (responseFinished) return;
          void (async () => {
            try {
              sendStatus("completed", `CEO run ${status}.`, { runId, status });
              if (ceoRunId) {
                const reply = await readRunReply(ceoRunId);
                if (reply) {
                  await finishWithAssistant(reply);
                  return;
                }
              }
              const fallbackReply = await readSessionRunReplySince(
                session.companyId,
                sessionId,
                ceoAgent.id,
                requestStartedAt,
                8_000,
              );
              if (fallbackReply) {
                await finishWithAssistant(fallbackReply);
                return;
              }
              await finishWithAssistant("Run completed without a structured assistant summary.");
            } catch (err) {
              logger.warn({ err, ceoRunId }, "Failed to hydrate CEO chat reply from run result");
              if (!responseFinished) {
                await finishWithAssistant("Failed to collect CEO reply from run output.");
              }
            }
          })();
        }
      }
    });

    req.on("close", () => {
      if (completionTimer) clearTimeout(completionTimer);
      responseFinished = true;
      unsubscribe();
    });

    try {
      const wakeResult = await heartbeat.wakeup(ceoAgent.id, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "ceo_chat",
        contextSnapshot: {
          taskKey: `ceo-chat-${sessionId}`,
          taskSource: "ceo_chat",
          chatMessage: content,
          chatSessionId: sessionId,
        },
        payload: {
          chatMessage: content,
          chatSessionId: sessionId,
        },
      });

      if (!wakeResult) {
        queuedWithoutRunId = true;
        sendStatus("queued", "CEO is busy; request queued and waiting.");
        void (async () => {
          const reply = await readSessionRunReplySince(
            session.companyId,
            sessionId,
            ceoAgent.id,
            requestStartedAt,
            180_000,
          );
          if (!reply || responseFinished) return;
          await finishWithAssistant(reply);
        })();
        return;
      }

      ceoRunId = (wakeResult as { id: string }).id;
      sendStatus("queued", "Request accepted and queued for execution.", { runId: ceoRunId });
    } catch (err) {
      logger.error({ err, sessionId }, "CEO chat invoke failed");
      unsubscribe();
      const errorMsg = `Failed to reach CEO: ${err instanceof Error ? err.message : String(err)}`;
      const [asstMsg] = await db
        .insert(chatMessages)
        .values({ sessionId, role: "assistant", content: errorMsg })
        .returning();
      res.write(`event: message\ndata: ${JSON.stringify(asstMsg)}\n\n`);
      res.write("event: done\ndata: {}\n\n");
      res.end();
      return;
    }
  });

  // ── DELETE /api/chat/sessions/:id/messages/:messageId ──────────────────

  router.delete("/chat/sessions/:id/messages/:messageId", async (req, res) => {
    const { id: sessionId, messageId } = req.params as { id: string; messageId: string };
    const [session] = await db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);

    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    assertCompanyAccess(req, session.companyId);

    const [deleted] = await db
      .delete(chatMessages)
      .where(and(eq(chatMessages.sessionId, sessionId), eq(chatMessages.id, messageId)))
      .returning();

    if (!deleted) {
      res.status(404).json({ error: "Message not found" });
      return;
    }

    res.json({ ok: true });
  });

  return router;
}
