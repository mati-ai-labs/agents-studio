import { useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, LoaderCircle } from "lucide-react";
import { aiSubscriptionsApi } from "@/api/aiSubscriptions";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

/**
 * "Run with" control: Studio default vs. the signed-in user's own Claude/Codex
 * subscription. The server only ever attaches the caller's own subscription.
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
    mutationFn: (enabled: boolean) => aiSubscriptionsApi.setForIssue(issueId, enabled),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.aiSubscriptions.issue(issueId) });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not update"),
  });

  const data = query.data;
  if (!assigneeAgentId || !data) return null;
  // Only meaningful for Claude Code / Codex agents, or when someone already attached one.
  if (!data.provider && !data.ownerUserId) return null;

  const providerName = data.provider === "codex" ? "Codex" : "Claude";
  const usingMine = data.isMine;
  const usingOther = Boolean(data.ownerUserId && !data.isMine);
  const myActive = data.mySubscription?.status === "active";

  const pill = (active: boolean) =>
    cn(
      "rounded px-2 py-0.5 text-xs border transition-colors",
      active ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-accent/50",
    );

  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="text-xs text-muted-foreground shrink-0 w-20 mt-0.5">Run with</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {usingOther ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
            <span>{data.ownerName ?? "Another user"}'s {providerName} subscription</span>
            {data.canClear ? (
              <button type="button" className={pill(false)} disabled={mutation.isPending} onClick={() => mutation.mutate(false)}>
                Switch to Studio default
              </button>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              className={pill(!usingMine)}
              disabled={mutation.isPending || !usingMine}
              onClick={() => mutation.mutate(false)}
            >
              Studio default
            </button>
            <button
              type="button"
              className={pill(usingMine)}
              disabled={mutation.isPending || usingMine || !myActive || !data.provider}
              onClick={() => mutation.mutate(true)}
              title={!myActive ? `Connect your ${providerName} subscription first` : undefined}
            >
              My {providerName} subscription
            </button>
            {mutation.isPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
          </div>
        )}
        {!usingOther && data.provider && !myActive ? (
          <Link to="/instance/settings/ai-subscriptions" className="text-xs text-muted-foreground underline">
            {data.mySubscription?.status === "invalid" ? `Reconnect your ${providerName} subscription` : `Connect your ${providerName} subscription`}
          </Link>
        ) : null}
        {usingMine && data.mySubscription?.status === "invalid" ? (
          <span className="text-xs text-destructive">Your subscription needs reconnecting. Runs on this issue are paused until then.</span>
        ) : null}
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>
    </div>
  );
}
