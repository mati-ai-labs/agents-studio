import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { chatSessions, chatMessages } from "@paperclipai/db";
import { and, desc, eq } from "drizzle-orm";
import { assertCompanyAccess } from "./authz.js";
import { logger } from "../middleware/logger.js";

export function chatRoutes(db: Db) {
  const router = Router();

  // ── helpers ────────────────────────────────────────────────────────────────

  async function buildChatSession(session: typeof chatSessions.$inferSelect) {
    const messages = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, session.id))
      .orderBy(chatMessages.createdAt);
    return { ...session, messages };
  }

  function parseSseBuffer(buffer: string): Array<{ event: string; data: string }> {
    const events: Array<{ event: string; data: string }> = [];
    const blocks = buffer.split(/\n\n/);
    for (const block of blocks) {
      if (!block.trim() || block.startsWith(":")) continue;
      let event = "message";
      const dataLines: string[] = [];
      for (const line of block.split(/\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length > 0) events.push({ event, data: dataLines.join("\n") });
    }
    return events;
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
  // Session-scoped chat with the external LangGraph orchestrator.

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

    let responseFinished = false;
    const abortController = new AbortController();
    let completionTimer: NodeJS.Timeout | null = null;

    const sendEvent = (event: string, payload: Record<string, unknown>) => {
      if (responseFinished || !res.writable) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    const sendStatus = (status: string, message: string, extra?: Record<string, unknown>) => {
      sendEvent("status", { status, message, ...(extra ?? {}) });
    };

    const finishWithAssistant = async (assistantContent: string) => {
      if (responseFinished || !res.writable) return;
      responseFinished = true;
      if (completionTimer) clearTimeout(completionTimer);
      const contentToStore = assistantContent.trim() || "No response generated.";
      const [asstMsg] = await db
        .insert(chatMessages)
        .values({ sessionId, role: "assistant", content: contentToStore })
        .returning();
      await db
        .update(chatSessions)
        .set({ updatedAt: new Date() })
        .where(eq(chatSessions.id, sessionId));
      res.write(`event: message\ndata: ${JSON.stringify(asstMsg)}\n\n`);
      res.write("event: done\ndata: {}\n\n");
      res.end();
    };
    completionTimer = setTimeout(() => {
      if (responseFinished) return;
      void finishWithAssistant(
        "LangGraph is still processing your request. Try again in a moment to check for completion.",
      );
    }, 180_000);

    req.on("close", () => {
      if (completionTimer) clearTimeout(completionTimer);
      responseFinished = true;
      abortController.abort();
    });

    sendStatus("queued", "Sending request to LangGraph.");

    try {
      const orchestratorUrl = process.env.ORCHESTRATOR_URL || "http://127.0.0.1:3101";

      const streamRes = await fetch(`${orchestratorUrl}/orchestrator/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          session_id: sessionId,
          company_id: session.companyId,
          user_id: (req as any).actor?.userId || "",
          message: content,
        }),
      });

      if (!streamRes.ok || !streamRes.body) {
        throw new Error(`Orchestrator returned ${streamRes.status}`);
      }

      sendStatus("running", "LangGraph is preparing a response.");

      const reader = streamRes.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let finalAssistant = "";
      let doneReceived = false;

      while (!responseFinished) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const parts = pending.split(/\n\n/);
        pending = parts.pop() ?? "";

        for (const part of parts) {
          for (const evt of parseSseBuffer(`${part}\n\n`)) {
            if (evt.event === "message") {
              try {
                const parsed = JSON.parse(evt.data) as { content?: string };
                if (typeof parsed.content === "string" && parsed.content.length > 0) {
                  finalAssistant += parsed.content;
                  sendEvent("chunk", { content: parsed.content });
                }
              } catch {
                // Ignore malformed chunks from orchestrator and continue.
              }
            } else if (evt.event === "status") {
              try {
                const parsed = JSON.parse(evt.data) as { status?: string; message?: string };
                sendStatus(parsed.status ?? "running", parsed.message ?? "LangGraph is processing your request.");
              } catch {
                sendStatus("running", "LangGraph is processing your request.");
              }
            } else if (evt.event === "error") {
              const parsed = JSON.parse(evt.data) as { error?: string };
              await finishWithAssistant(parsed.error ? `Orchestrator error: ${parsed.error}` : "Orchestrator error.");
              return;
            } else if (evt.event === "done") {
              doneReceived = true;
            }
          }
        }
      }

      if (responseFinished) return;

      if (pending.trim().length > 0) {
        for (const evt of parseSseBuffer(`${pending}\n\n`)) {
          if (evt.event === "message") {
            try {
              const parsed = JSON.parse(evt.data) as { content?: string };
              if (typeof parsed.content === "string" && parsed.content.length > 0) {
                finalAssistant += parsed.content;
                sendEvent("chunk", { content: parsed.content });
              }
            } catch {
              // Ignore malformed chunk.
            }
          } else if (evt.event === "done") {
            doneReceived = true;
          } else if (evt.event === "error") {
            const parsed = JSON.parse(evt.data) as { error?: string };
            await finishWithAssistant(parsed.error ? `Orchestrator error: ${parsed.error}` : "Orchestrator error.");
            return;
          }
        }
      }

      if (!finalAssistant.trim()) {
        await finishWithAssistant(
          doneReceived
            ? "No response generated."
            : "Orchestrator stream ended before a response was produced.",
        );
        return;
      }

      await finishWithAssistant(finalAssistant);
    } catch (err) {
      if (abortController.signal.aborted || responseFinished) return;
      logger.error({ err, sessionId }, "Orchestrator chat invoke failed");
      await finishWithAssistant(`Orchestrator unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ── GET /api/chat/sessions/:id/context ─────────────────────────────────

  router.get("/chat/sessions/:id/context", async (req, res) => {
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

    const context = session.metadata ? JSON.parse(session.metadata) : {};
    res.json(context);
  });

  // ── PATCH /api/chat/sessions/:id/context ─────────────────────────────────

  router.patch("/chat/sessions/:id/context", async (req, res) => {
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

    const existing = session.metadata ? JSON.parse(session.metadata) : {};
    const updates = req.body; // partial merge
    const merged = { ...existing, ...updates };
    await db
      .update(chatSessions)
      .set({ metadata: JSON.stringify(merged) })
      .where(eq(chatSessions.id, id));
    res.json({ ok: true });
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
