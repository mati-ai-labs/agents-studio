import { useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, LoaderCircle } from "lucide-react";
import { aiSubscriptionsApi, type AiSubscriptionProvider } from "@/api/aiSubscriptions";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { SubscriptionModelSelect } from "./SubscriptionModelSelect";

const PROVIDERS: Array<{ id: AiSubscriptionProvider; label: string }> = [
  { id: "claude", label: "My Claude subscription" },
  { id: "codex", label: "My Codex subscription" },
];

/**
 * "Run with": Studio default, or one of the signed-in user's own subscriptions
 * (any provider; a different provider than the agent's runs that CLI instead).
 * The server only ever attaches the caller's own subscription.
 */
export function IssueRunWithRow({ issueId, assigneeAgentId }: { issueId: string; assigneeAgentId: string | null }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: [...queryKeys.aiSubscriptions.issue(issueId), assigneeAgentId],
    queryFn: () => aiSubscriptionsApi.getForIssue(issueId),
    enabled: Boolean(assigneeAgentId),
  });
  const mutation = useMutation({
    mutationFn: (next: { enabled: boolean; provider?: AiSubscriptionProvider; model?: string | null }) =>
      aiSubscriptionsApi.setForIssue(issueId, next.enabled, { provider: next.provider, model: next.model }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.aiSubscriptions.issue(issueId) });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not update"),
  });

  const data = query.data;
  if (!assigneeAgentId || !data) return null;

  const usingOther = Boolean(data.ownerUserId && !data.isMine);
  const activeProvider = data.isMine ? data.provider : null;
  const isConnected = (provider: AiSubscriptionProvider) =>
    data.mySubscriptions.some((sub) => sub.provider === provider && sub.status === "active");
  const anyConnected = PROVIDERS.some((p) => isConnected(p.id));
  const crossCli = Boolean(activeProvider && data.agentProvider && activeProvider !== data.agentProvider);

  const pill = (active: boolean) =>
    cn(
      "rounded px-2 py-0.5 text-xs border transition-colors disabled:opacity-50",
      active ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-accent/50",
    );

  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="text-xs text-muted-foreground shrink-0 w-20 mt-0.5">Run with</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {usingOther ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
            <span>
              {data.ownerName ?? "Another user"}'s {data.provider === "codex" ? "Codex" : "Claude"} subscription
              {data.model ? ` · ${data.model}` : ""}
            </span>
            {data.canClear ? (
              <button type="button" className={pill(false)} disabled={mutation.isPending} onClick={() => mutation.mutate({ enabled: false })}>
                Switch to Studio default
              </button>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              className={pill(!activeProvider)}
              disabled={mutation.isPending || !activeProvider}
              onClick={() => mutation.mutate({ enabled: false })}
            >
              Studio default
            </button>
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={pill(activeProvider === p.id)}
                disabled={mutation.isPending || activeProvider === p.id || !isConnected(p.id)}
                title={!isConnected(p.id) ? `Connect your ${p.id === "codex" ? "Codex" : "Claude"} subscription first` : undefined}
                onClick={() => mutation.mutate({ enabled: true, provider: p.id })}
              >
                {p.label}
              </button>
            ))}
            {mutation.isPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
          </div>
        )}
        {activeProvider ? (
          <SubscriptionModelSelect
            provider={activeProvider}
            value={data.model}
            disabled={mutation.isPending}
            onChange={(model) => mutation.mutate({ enabled: true, provider: activeProvider, model })}
          />
        ) : null}
        {crossCli ? (
          <span className="text-xs text-muted-foreground">
            Runs with {activeProvider === "codex" ? "Codex" : "Claude Code"} instead of the agent's usual CLI (same instructions, skills and workspace).
          </span>
        ) : null}
        {!usingOther && !anyConnected ? (
          <Link to="/instance/settings/ai-subscriptions" className="text-xs text-muted-foreground underline">
            Connect a Claude or Codex subscription
          </Link>
        ) : null}
        {activeProvider && !isConnected(activeProvider) ? (
          <span className="text-xs text-destructive">Your subscription needs reconnecting. Runs on this issue are paused until then.</span>
        ) : null}
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>
    </div>
  );
}
