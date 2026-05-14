import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { chatApi, type ChatMessage, type ChatSession } from "@/api/chat";

export default function CeoChat() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSession, setActiveSession] = useState<ChatSession | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftAssistant, setDraftAssistant] = useState("");
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "CEO Chat", href: "/ceo" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeSession?.messages, draftAssistant]);

  async function refreshSessions(companyId = selectedCompanyId) {
    if (!companyId) return;
    const next = await chatApi.listSessions(companyId);
    setSessions(next);
  }

  useEffect(() => {
    if (!selectedCompanyId) return;
    setError(null);
    refreshSessions(selectedCompanyId).catch((err) => {
      setError(err instanceof Error ? err.message : "Failed to load chats");
    });
  }, [selectedCompanyId]);

  async function createNewChat() {
    if (!selectedCompanyId) return;
    setLoading(true);
    setError(null);
    try {
      const session = await chatApi.createSession(selectedCompanyId);
      setSessions((prev) => [session, ...prev]);
      setActiveSession({ ...session, messages: [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create chat");
    } finally {
      setLoading(false);
    }
  }

  async function openSession(sessionId: string) {
    setLoading(true);
    setError(null);
    try {
      setActiveSession(await chatApi.getSession(sessionId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open chat");
    } finally {
      setLoading(false);
    }
  }

  async function removeSession(sessionId: string) {
    if (!confirm("Delete this chat?")) return;
    setError(null);
    try {
      await chatApi.deleteSession(sessionId);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (activeSession?.id === sessionId) setActiveSession(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete chat");
    }
  }

  async function send() {
    if (!activeSession || !input.trim() || sending) return;
    const content = input.trim();
    setInput("");
    setSending(true);
    setDraftAssistant("");
    setError(null);

    const optimisticUser: ChatMessage = {
      id: `local-user-${Date.now()}`,
      sessionId: activeSession.id,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    setActiveSession((prev) => prev ? { ...prev, messages: [...(prev.messages ?? []), optimisticUser] } : prev);

    try {
      await chatApi.sendMessage(activeSession.id, content, {
        onUserMessage: (message) => {
          setActiveSession((prev) => {
            if (!prev) return prev;
            const withoutOptimistic = (prev.messages ?? []).filter((m) => m.id !== optimisticUser.id);
            return { ...prev, messages: [...withoutOptimistic, message] };
          });
        },
        onChunk: (chunk) => setDraftAssistant((prev) => prev + chunk),
        onAssistantMessage: (message) => {
          setActiveSession((prev) => prev ? { ...prev, messages: [...(prev.messages ?? []), message] } : prev);
          setDraftAssistant("");
        },
        onError: (msg) => setError(msg),
      });
      await refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  }

  const visibleMessages = useMemo(() => activeSession?.messages ?? [], [activeSession]);

  return (
    <div className="flex h-full min-h-[calc(100vh-64px)] overflow-hidden bg-background">
      <aside className="flex w-72 shrink-0 flex-col border-r bg-muted/20">
        <div className="flex items-center justify-between border-b p-4">
          <div>
            <h1 className="text-sm font-semibold">CEO Chat</h1>
            <p className="text-xs text-muted-foreground">Delegate work to the company brain</p>
          </div>
          <Button size="sm" onClick={createNewChat} disabled={!selectedCompanyId || loading}>New</Button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {sessions.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">No chats yet.</div>
          ) : sessions.map((session) => (
            <button
              key={session.id}
              onClick={() => openSession(session.id)}
              className={`group mb-1 flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm hover:bg-muted ${activeSession?.id === session.id ? "bg-muted" : ""}`}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{session.title || "New Chat"}</span>
                <span className="block text-xs text-muted-foreground">{new Date(session.updatedAt).toLocaleString()}</span>
              </span>
              <span
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation();
                  removeSession(session.id);
                }}
                className="ml-2 hidden rounded px-2 py-1 text-muted-foreground hover:bg-background hover:text-foreground group-hover:inline-block"
              >
                ×
              </span>
            </button>
          ))}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="border-b p-4">
          <h2 className="text-base font-semibold">Talk to the CEO Agent</h2>
          <p className="text-sm text-muted-foreground">Ask it to create tasks, assign agents, coordinate execution, and report status.</p>
        </div>

        {error ? <div className="m-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}

        {!activeSession ? (
          <div className="flex flex-1 items-center justify-center p-8">
            <Card className="max-w-lg p-8 text-center">
              <div className="mb-3 text-4xl">🧠</div>
              <h3 className="mb-2 text-lg font-semibold">Central Orchestrator</h3>
              <p className="mb-5 text-sm text-muted-foreground">
                This is the chat-first interface for the agent company. Start here instead of manually creating issues.
              </p>
              <Button onClick={createNewChat} disabled={!selectedCompanyId || loading}>Start CEO Chat</Button>
            </Card>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto p-6">
              <div className="mx-auto flex max-w-4xl flex-col gap-4">
                {visibleMessages.length === 0 && !draftAssistant ? (
                  <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                    Try: “Create a task for the sales agent to review all stale leads and follow up.”
                  </div>
                ) : null}
                {visibleMessages.map((message) => (
                  <div key={message.id} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[75%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6 ${message.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                      {message.content}
                    </div>
                  </div>
                ))}
                {draftAssistant ? (
                  <div className="flex justify-start">
                    <div className="max-w-[75%] whitespace-pre-wrap rounded-2xl bg-muted px-4 py-3 text-sm leading-6">
                      {draftAssistant}
                    </div>
                  </div>
                ) : null}
                <div ref={messagesEndRef} />
              </div>
            </div>

            <div className="border-t p-4">
              <div className="mx-auto flex max-w-4xl gap-3">
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      send();
                    }
                  }}
                  disabled={sending}
                  placeholder="Tell the CEO agent what to get done..."
                  className="min-h-[48px] flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <Button onClick={send} disabled={!input.trim() || sending}>{sending ? "Sending..." : "Send"}</Button>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
