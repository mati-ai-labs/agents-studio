import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MarkdownBody } from "@/components/MarkdownBody";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { chatApi, type ChatMessage, type ChatSession, type IssueCreatedData } from "@/api/chat";
import { useParams } from "@/lib/router";

interface PlanningEvent {
  text: string;
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm text-slate-600 shadow-sm">
      <div className="flex items-center gap-1.5" aria-label="Orchestrator is thinking" role="status">
        <span className="h-2 w-2 animate-pulse rounded-full bg-slate-400" />
        <span className="h-2 w-2 animate-pulse rounded-full bg-slate-400 [animation-delay:150ms]" />
        <span className="h-2 w-2 animate-pulse rounded-full bg-slate-400 [animation-delay:300ms]" />
      </div>
      <span>Orchestrator is thinking...</span>
    </div>
  );
}

export default function CeoChat() {
  const { selectedCompanyId } = useCompany();
  const { companyPrefix } = useParams<{ companyPrefix: string }>();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSession, setActiveSession] = useState<ChatSession | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftAssistant, setDraftAssistant] = useState("");
  const [runStatusText, setRunStatusText] = useState<string | null>(null);
  const [planningText, setPlanningText] = useState<string | null>(null);
  const [createdIssue, setCreatedIssue] = useState<IssueCreatedData | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Orchestrator Chat", href: `/${companyPrefix}/chat` }]);
  }, [companyPrefix, setBreadcrumbs]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeSession?.messages, draftAssistant, planningText]);

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
      setResponding(false);
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
      setResponding(false);
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
    setResponding(true);
    setDraftAssistant("");
    setRunStatusText(null);
    setPlanningText(null);
    setCreatedIssue(null);
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
        onPlanning: (data: PlanningEvent) => setPlanningText(data.text),
        onIssueCreated: (data: IssueCreatedData) => setCreatedIssue(data),
        onStatus: (data) => setRunStatusText(data.message || data.status),
        onAssistantMessage: (message) => {
          setActiveSession((prev) => prev ? { ...prev, messages: [...(prev.messages ?? []), message] } : prev);
          setDraftAssistant("");
          setRunStatusText(null);
          setResponding(false);
        },
        onError: (msg) => {
          setError(msg);
          setResponding(false);
        },
        onDone: () => {
          setRunStatusText(null);
          setResponding(false);
        },
      });
      await refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
      setResponding(false);
    } finally {
      setSending(false);
    }
  }

  const visibleMessages = useMemo(() => activeSession?.messages ?? [], [activeSession]);

  return (
    <div className="flex h-full min-h-[calc(100vh-64px)] overflow-hidden bg-gradient-to-b from-slate-50 via-background to-teal-50/30">
      <aside className="flex w-72 shrink-0 flex-col border-r border-slate-200/70 bg-white/70 backdrop-blur">
        <div className="flex items-center justify-between border-b border-slate-200/70 p-4">
          <div>
            <h1 className="text-sm font-semibold">Orchestrator Chat</h1>
            <p className="text-xs text-muted-foreground">Company orchestration console</p>
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
              className={`group mb-1.5 flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-sm transition-colors ${activeSession?.id === session.id ? "border-teal-200 bg-teal-50/70" : "border-transparent hover:border-slate-200 hover:bg-slate-100/80"}`}
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
                className="ml-2 hidden rounded-md px-2 py-1 text-muted-foreground hover:bg-white hover:text-foreground group-hover:inline-block"
              >
                ×
              </span>
            </button>
          ))}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-slate-200/70 bg-white/70 p-4 backdrop-blur">
          <h2 className="text-base font-semibold">Talk to the Orchestrator</h2>
          <p className="text-sm text-muted-foreground">Create tasks, assign owners, and track execution from one thread.</p>
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
              <Button onClick={createNewChat} disabled={!selectedCompanyId || loading}>Start Orchestrator Chat</Button>
            </Card>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto p-6">
              <div className="mx-auto flex max-w-4xl flex-col gap-4">
                {visibleMessages.length === 0 && !draftAssistant && !planningText && !responding ? (
                  <div className="rounded-xl border border-dashed border-slate-300 bg-white/70 p-8 text-center text-sm text-muted-foreground">
                    Try: "Create a task for the sales agent to review all stale leads and follow up."
                  </div>
                ) : null}
                {visibleMessages.map((message) => (
                  <div key={message.id} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-6 shadow-sm ${message.role === "user" ? "bg-slate-900 ceo-chat-user-msg" : "border border-slate-200 bg-white"}`}>
                      <MarkdownBody>{message.content}</MarkdownBody>
                    </div>
                  </div>
                ))}
                {planningText && (
                  <div className="flex justify-start">
                    <div className="max-w-[75%] whitespace-pre-wrap rounded-2xl bg-blue-50 px-4 py-3 text-sm leading-6 text-blue-700">
                      {planningText}
                    </div>
                  </div>
                )}
                {runStatusText ? (
                  <div className="flex justify-start">
                    <div className="max-w-[80%] rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 shadow-sm">
                      <MarkdownBody>{runStatusText}</MarkdownBody>
                    </div>
                  </div>
                ) : null}
                {draftAssistant ? (
                  <div className="flex justify-start">
                    <div className="max-w-[80%] rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm leading-6 shadow-sm">
                      <MarkdownBody>{draftAssistant}</MarkdownBody>
                    </div>
                  </div>
                ) : null}
                {responding && !draftAssistant ? (
                  <div className="flex justify-start">
                    <ThinkingIndicator />
                  </div>
                ) : null}
                {createdIssue && (
                  <div className="flex justify-start">
                    <div className="max-w-[80%] rounded-2xl border border-green-200 bg-green-50 px-4 py-3 text-sm shadow-sm">
                      <div className="mb-1 flex items-center gap-2 font-medium text-green-800">
                        <span>✅</span> Issue created
                      </div>
                      <div className="text-gray-700">
                        <span className="font-medium">{createdIssue.title}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-2 text-xs text-gray-500">
                        {createdIssue.issueIdentifier !== createdIssue.issueId && (
                          <span className="rounded bg-gray-200 px-1.5 py-0.5">{createdIssue.issueIdentifier}</span>
                        )}
                        {createdIssue.assigneeAgentName && (
                          <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-700">Assigned to {createdIssue.assigneeAgentName}</span>
                        )}
                        <a
                          href={companyPrefix ? `/${companyPrefix}/issues/${createdIssue.issueId}` : `/issues/${createdIssue.issueId}`}
                          className="text-blue-600 hover:underline"
                        >
                          View issue →
                        </a>
                      </div>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            </div>

            <div className="border-t border-slate-200/70 bg-white/80 p-4 backdrop-blur">
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
                  placeholder="Tell the Orchestrator what to get done..."
                  className="min-h-[52px] flex-1 resize-none rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-300"
                />
                <Button onClick={send} disabled={!input.trim() || sending}>Send</Button>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
