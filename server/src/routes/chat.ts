import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { chatSessions, chatMessages } from "@paperclipai/db";
import { and, desc, eq } from "drizzle-orm";
import { agentService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";

export function chatRoutes(db: Db) {
  const router = Router();
  const agentsSvc = agentService(db);

  // ── helpers ────────────────────────────────────────────────────────────────

  async function resolveCeoAgent(companyId: string) {
    const agents = await agentsSvc.list(companyId);
    return agents.find((a) => a.role === "ceo") ?? null;
  }

  async function buildChatSession(session: typeof chatSessions.$inferSelect) {
    const messages = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, session.id))
      .orderBy(chatMessages.createdAt);
    return { ...session, messages };
  }

  // ── POST /api/chat/sessions ─────────────────────────────────────────────
  // Create a new chat session for the company.

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
  // List all chat sessions for the company.

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
  // Get a single session with all messages.

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
  // Delete a session and all its messages (cascade).

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
  // Send a message and stream back the CEO agent response via SSE.

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

    // Update session updatedAt
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

    // Send initial ping to establish connection
    res.write(": connected\n\n");

    // Emit user message event
    res.write(`event: message\ndata: ${JSON.stringify(userMsg)}\n\n`);

    // Find the CEO agent
    const ceoAgent = await resolveCeoAgent(session.companyId);
    let assistantContent = "";

    if (!ceoAgent) {
      const noCeo = "No CEO agent found in this company. Please configure a CEO agent first.";
      assistantContent = noCeo;

      const [asstMsg] = await db
        .insert(chatMessages)
        .values({ sessionId, role: "assistant", content: noCeo })
        .returning();

      res.write(`event: message\ndata: ${JSON.stringify(asstMsg)}\n\n`);
      res.write("event: done\ndata: {}\n\n");
      res.end();
      return;
    }

    // MVP orchestrator response. This establishes the central chat contract and
    // persistence path. The next iteration can replace this deterministic planner
    // with adapter-backed tool calls that create issues/assign agents directly.
    const chunks = [
      `Got it. I’ll coordinate this through the company agent system.\n\n`,
      `CEO agent: ${ceoAgent.name ?? ceoAgent.id}\n`,
      `Requested work: ${content}\n\n`,
      `Next actions I would take:\n`,
      `1. Break this into one or more issues.\n`,
      `2. Assign each issue to the best available specialist agent.\n`,
      `3. Track progress via heartbeats and report blockers back here.`,
    ];

    for (const chunk of chunks) {
      assistantContent += chunk;
      res.write(`event: chunk\ndata: ${JSON.stringify({ content: chunk })}\n\n`);
    }

    // Save the complete assistant message
    const [asstMsg] = await db
      .insert(chatMessages)
      .values({ sessionId, role: "assistant", content: assistantContent })
      .returning();

    res.write(`event: message\ndata: ${JSON.stringify(asstMsg)}\n\n`);
    res.write("event: done\ndata: {}\n\n");
    res.end();
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
      .where(and(eq(chatMessages.id, messageId), eq(chatMessages.sessionId, sessionId)))
      .returning();

    if (!deleted) {
      res.status(404).json({ error: "Message not found" });
      return;
    }

    res.json({ ok: true });
  });

  return router;
}