import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { chatSessions, chatMessages, issues as issueRows } from "@paperclipai/db";
import { and, desc, eq } from "drizzle-orm";
import { agentService, issueService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";
import { logger } from "../middleware/logger.js";

function buildIssueTitle(content: string): string {
  const firstLine = content.split("\n")[0].trim();
  if (firstLine.length <= 100) return firstLine;
  return firstLine.slice(0, 97) + "...";
}

function buildIssueDescription(content: string, agentName: string | null): string {
  return `## Request from CEO Chat\n\n${content}\n\n_Assigned via CEO Chat${agentName ? ` to ${agentName}` : ""}._`;
}

async function resolveTargetAgent(
  agentsSvc: ReturnType<typeof agentService>,
  companyId: string,
  content: string,
): Promise<{ agentId: string | null; agentName: string | null; matchedBy: string }> {
  const agents = await agentsSvc.list(companyId);

  // Check for explicit agent mentions via "for <name>" or "to <name>" patterns
  const explicitMatch = agents.find((agent) => {
    const name = agent.name?.toLowerCase() ?? "";
    const patterns = [
      new RegExp(`\\bfor\\s+${name}\\b`, "i"),
      new RegExp(`\\bto\\s+${name}\\b`, "i"),
      new RegExp(`\\bask\\s+${name}\\b`, "i"),
      new RegExp(`\\bassign\\s+${name}\\b`, "i"),
    ];
    return name.length > 0 && (patterns.some((re) => re.test(content)) || content.toLowerCase().includes(name));
  });

  if (explicitMatch) {
    return { agentId: explicitMatch.id, agentName: explicitMatch.name ?? null, matchedBy: "explicit_name" };
  }

  // Fall back to CEO agent
  const ceo = agents.find((a) => a.role === "ceo");
  if (ceo) {
    return { agentId: ceo.id, agentName: ceo.name ?? null, matchedBy: "fallback_ceo" };
  }

  // Last resort: first active agent
  const firstAgent = agents.find((a) => a.status !== "paused");
  return { agentId: firstAgent?.id ?? null, agentName: firstAgent?.name ?? null, matchedBy: "fallback_first" };
}

export function chatRoutes(db: Db) {
  const router = Router();
  const agentsSvc = agentService(db);
  const issuesSvc = issueService(db);

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

    if (!ceoAgent) {
      const noCeo = "No CEO agent found in this company. Please configure a CEO agent first.";

      const [asstMsg] = await db
        .insert(chatMessages)
        .values({ sessionId, role: "assistant", content: noCeo })
        .returning();

      res.write(`event: message\ndata: ${JSON.stringify(asstMsg)}\n\n`);
      res.write("event: done\ndata: {}\n\n");
      res.end();
      return;
    }

    // Resolve target agent and create issue with real orchestration
    const targetAgent = await resolveTargetAgent(agentsSvc, session.companyId, content);

    let createdIssue: typeof issueRows.$inferSelect | null = null;
    let errorMessage: string | null = null;

    res.write(`event: planning\ndata: ${JSON.stringify({ text: "Analyzing request..." })}\n\n`);

    try {
      res.write(`event: planning\ndata: ${JSON.stringify({ text: `Assigning to ${targetAgent.agentName ?? "agent"} (matched by: ${targetAgent.matchedBy})...` })}\n\n`);

      const issueTitle = buildIssueTitle(content);
      const issueDescription = buildIssueDescription(content, targetAgent.agentName);

      res.write(`event: planning\ndata: ${JSON.stringify({ text: "Creating issue..." })}\n\n`);

      const issue = await issuesSvc.create(session.companyId, {
        title: issueTitle,
        description: issueDescription,
        assigneeAgentId: targetAgent.agentId,
        status: "backlog",
        priority: "medium",
        originKind: "ceo_chat",
        createdByAgentId: ceoAgent.id,
      });

      createdIssue = issue;

      res.write(`event: issue_created\ndata: ${JSON.stringify({
        issueId: issue.id,
        issueIdentifier: issue.identifier ?? issue.id,
        title: issue.title,
        assigneeAgentId: targetAgent.agentId,
        assigneeAgentName: targetAgent.agentName,
      })}\n\n`);
    } catch (err) {
      logger.error({ err, sessionId }, "CEO chat failed to create issue");
      errorMessage = err instanceof Error ? err.message : "Failed to create issue";
    }

    // Build the final assistant response
    let assistantContent = "";

    if (errorMessage) {
      assistantContent = `Got it -- I understood the request but ran into an issue: ${errorMessage}.\n\nPlease try again or contact your administrator.`;
    } else if (createdIssue) {
      const identifier = createdIssue.identifier ?? createdIssue.id.slice(0, 8);
      assistantContent = `**Task created**\n\n`;
      assistantContent += `**Issue:** ${createdIssue.title}\n`;
      assistantContent += `**ID:** ${identifier}\n`;
      if (targetAgent.agentName) {
        assistantContent += `**Assigned to:** ${targetAgent.agentName}\n`;
      }
      assistantContent += `\n_Track progress in the Issues board._`;
    } else {
      assistantContent = `I understood the request but was unable to create a task. Please try again.`;
    }

    // Stream the final response
    res.write(`event: chunk\ndata: ${JSON.stringify({ content: assistantContent })}\n\n`);

    // Persist the assistant message with metadata if we created an issue
    const metadata = createdIssue ? JSON.stringify({ issueId: createdIssue.id, assigneeAgentId: targetAgent.agentId }) : null;
    const [asstMsg] = await db
      .insert(chatMessages)
      .values({ sessionId, role: "assistant", content: assistantContent, metadata })
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