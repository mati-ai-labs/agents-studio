import { api } from "./client";

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: string | null;
  createdAt: string;
}

export interface ChatSession {
  id: string;
  companyId: string;
  title: string;
  status: "active" | "archived" | string;
  createdAt: string;
  updatedAt: string;
  messages?: ChatMessage[];
}

export interface IssueCreatedData {
  issueId: string;
  issueIdentifier: string;
  title: string;
  assigneeAgentId: string | null;
  assigneeAgentName: string | null;
}

export async function listSessions(companyId: string): Promise<ChatSession[]> {
  return api.get<ChatSession[]>(`/companies/${companyId}/chat/sessions`);
}

export async function getSession(sessionId: string): Promise<ChatSession> {
  return api.get<ChatSession>(`/chat/sessions/${sessionId}`);
}

export async function createSession(companyId: string, title = "New Chat"): Promise<ChatSession> {
  return api.post<ChatSession>(`/companies/${companyId}/chat/sessions`, { title });
}

export async function deleteSession(sessionId: string): Promise<void> {
  await api.delete(`/chat/sessions/${sessionId}`);
}

type SendMessageCallbacks = {
  onUserMessage?: (message: ChatMessage) => void;
  onChunk?: (chunk: string) => void;
  onPlanning?: (data: { text: string }) => void;
  onIssueCreated?: (data: IssueCreatedData) => void;
  onStatus?: (data: { status: string; message: string; runId?: string; error?: string }) => void;
  onAssistantMessage?: (message: ChatMessage) => void;
  onDone?: () => void;
  onError?: (error: string) => void;
};

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

export async function sendMessage(
  sessionId: string,
  content: string,
  callbacks: SendMessageCallbacks,
): Promise<void> {
  const response = await fetch(`/api/chat/sessions/${sessionId}/messages`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed: ${response.status}`);
  }

  if (!response.body) {
    callbacks.onDone?.();
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      pending += decoder.decode();
      break;
    }
    pending += decoder.decode(value, { stream: true });
    const parts = pending.split(/\n\n/);
    pending = parts.pop() ?? "";
    for (const part of parts) {
      for (const evt of parseSseBuffer(`${part}\n\n`)) {
        if (evt.event === "chunk") {
          const parsed = JSON.parse(evt.data) as { content?: string };
          callbacks.onChunk?.(parsed.content ?? "");
        } else if (evt.event === "message") {
          const msg = JSON.parse(evt.data) as ChatMessage;
          if (msg.role === "user") callbacks.onUserMessage?.(msg);
          if (msg.role === "assistant") callbacks.onAssistantMessage?.(msg);
        } else if (evt.event === "planning") {
          const parsed = JSON.parse(evt.data) as { text: string };
          callbacks.onPlanning?.(parsed);
        } else if (evt.event === "issue_created") {
          const parsed = JSON.parse(evt.data) as IssueCreatedData;
          callbacks.onIssueCreated?.(parsed);
        } else if (evt.event === "status") {
          const parsed = JSON.parse(evt.data) as { status?: string; message?: string; runId?: string; error?: string };
          callbacks.onStatus?.({
            status: parsed.status ?? "unknown",
            message: parsed.message ?? "",
            ...(parsed.runId ? { runId: parsed.runId } : {}),
            ...(parsed.error ? { error: parsed.error } : {}),
          });
        } else if (evt.event === "error") {
          const parsed = JSON.parse(evt.data) as { error?: string };
          callbacks.onError?.(parsed.error ?? "Unknown chat error");
        } else if (evt.event === "done") {
          callbacks.onDone?.();
        }
      }
    }
  }

  if (pending.trim().length > 0) {
    for (const evt of parseSseBuffer(`${pending}\n\n`)) {
      if (evt.event === "chunk") {
        const parsed = JSON.parse(evt.data) as { content?: string };
        callbacks.onChunk?.(parsed.content ?? "");
      } else if (evt.event === "message") {
        const msg = JSON.parse(evt.data) as ChatMessage;
        if (msg.role === "user") callbacks.onUserMessage?.(msg);
        if (msg.role === "assistant") callbacks.onAssistantMessage?.(msg);
      } else if (evt.event === "planning") {
        const parsed = JSON.parse(evt.data) as { text: string };
        callbacks.onPlanning?.(parsed);
      } else if (evt.event === "issue_created") {
        const parsed = JSON.parse(evt.data) as IssueCreatedData;
        callbacks.onIssueCreated?.(parsed);
      } else if (evt.event === "status") {
        const parsed = JSON.parse(evt.data) as { status?: string; message?: string; runId?: string; error?: string };
        callbacks.onStatus?.({
          status: parsed.status ?? "unknown",
          message: parsed.message ?? "",
          ...(parsed.runId ? { runId: parsed.runId } : {}),
          ...(parsed.error ? { error: parsed.error } : {}),
        });
      } else if (evt.event === "error") {
        const parsed = JSON.parse(evt.data) as { error?: string };
        callbacks.onError?.(parsed.error ?? "Unknown chat error");
      } else if (evt.event === "done") {
        callbacks.onDone?.();
      }
    }
  }
}

export const chatApi = {
  listSessions,
  getSession,
  createSession,
  deleteSession,
  sendMessage,
};
