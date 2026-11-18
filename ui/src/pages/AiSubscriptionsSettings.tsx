import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Copy, ExternalLink, KeyRound, LoaderCircle, TriangleAlert, Unplug } from "lucide-react";
import {
  aiSubscriptionsApi,
  type AiSubscriptionProvider,
  type AiSubscriptionSummary,
  type CodexDeviceLoginState,
} from "@/api/aiSubscriptions";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function formatWhen(value: string | null) {
  if (!value) return "never";
  return new Date(value).toLocaleString();
}

function StatusLine({ sub }: { sub: AiSubscriptionSummary | undefined }) {
  if (!sub) return <span className="text-sm text-muted-foreground">Not connected</span>;
  if (sub.status === "invalid") {
    return (
      <span className="flex items-center gap-1.5 text-sm text-destructive">
        <TriangleAlert className="h-4 w-4" />
        Needs reconnect{sub.lastError ? `: ${sub.lastError}` : ""}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
      <CheckCircle2 className="h-4 w-4" />
      Connected{sub.accountLabel ? ` · ${sub.accountLabel}` : ""} · last used {formatWhen(sub.lastUsedAt)}
    </span>
  );
}

function ProviderCard(props: {
  title: string;
  description: string;
  sub: AiSubscriptionSummary | undefined;
  onDisconnect: () => void;
  disconnecting: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{props.title}</h2>
          <p className="text-sm text-muted-foreground">{props.description}</p>
          <StatusLine sub={props.sub} />
        </div>
        {props.sub ? (
          <Button variant="outline" size="sm" onClick={props.onDisconnect} disabled={props.disconnecting}>
            <Unplug className="mr-1.5 h-4 w-4" />
            Disconnect
          </Button>
        ) : null}
      </div>
      {props.children}
    </section>
  );
}

function CodexDeviceLoginPanel({ state }: { state: CodexDeviceLoginState }) {
  const [copied, setCopied] = useState(false);
  if (state.state !== "pending") return null;
  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/40 p-4">
      <p className="text-sm font-medium">Finish signing in with ChatGPT</p>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li>
          Open{" "}
          {state.verificationUrl ? (
            <a className="inline-flex items-center gap-1 underline" href={state.verificationUrl} target="_blank" rel="noreferrer">
              {state.verificationUrl}
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : (
            "the OpenAI sign-in page"
          )}{" "}
          and sign in with the ChatGPT account whose plan you want to use.
        </li>
        <li className="space-y-1">
          <span>Enter this one-time code:</span>
          {state.userCode ? (
            <div className="flex items-center gap-2">
              <code className="rounded bg-background px-2 py-1 font-mono text-lg tracking-widest">{state.userCode}</code>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void navigator.clipboard.writeText(state.userCode ?? "");
                  setCopied(true);
                }}
              >
                <Copy className="mr-1 h-4 w-4" />
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          ) : (
            <span className="text-muted-foreground"> waiting for code…</span>
          )}
        </li>
      </ol>
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
        Waiting for you to approve. The code expires at {new Date(state.expiresAt).toLocaleTimeString()}.
      </p>
    </div>
  );
}

export function AiSubscriptionsSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [claudeToken, setClaudeToken] = useState("");
  const [codexAuthJson, setCodexAuthJson] = useState("");
  const [showCodexPaste, setShowCodexPaste] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Instance Settings" }, { label: "AI subscriptions" }]);
  }, [setBreadcrumbs]);

  const mineQuery = useQuery({
    queryKey: queryKeys.aiSubscriptions.mine,
    queryFn: () => aiSubscriptionsApi.listMine(),
    // Poll while a Codex device login is waiting for approval.
    refetchInterval: (query) => (query.state.data?.codexDeviceLogin.state === "pending" ? 3000 : false),
  });

  const deviceState = mineQuery.data?.codexDeviceLogin ?? { state: "idle" as const };
  const byProvider = new Map<AiSubscriptionProvider, AiSubscriptionSummary>(
    (mineQuery.data?.subscriptions ?? []).map((s) => [s.provider, s]),
  );

  useEffect(() => {
    if (deviceState.state === "succeeded") setNotice("Codex connected. Your ChatGPT plan is ready to use on issues.");
    if (deviceState.state === "failed" && deviceState.error !== "Cancelled") setActionError(`Codex sign-in failed: ${deviceState.error}`);
  }, [deviceState.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["ai-subscriptions"] });
  const onError = (error: unknown) => {
    setNotice(null);
    setActionError(errorText(error));
  };

  const saveClaude = useMutation({
    mutationFn: () => aiSubscriptionsApi.saveClaudeToken(claudeToken),
    onSuccess: () => {
      setClaudeToken("");
      setActionError(null);
      setNotice("Claude connected.");
      void invalidate();
    },
    onError,
  });
  const saveCodexJson = useMutation({
    mutationFn: () => aiSubscriptionsApi.saveCodexAuthJson(codexAuthJson),
    onSuccess: () => {
      setCodexAuthJson("");
      setShowCodexPaste(false);
      setActionError(null);
      setNotice("Codex connected.");
      void invalidate();
    },
    onError,
  });
  const startDevice = useMutation({
    mutationFn: () => aiSubscriptionsApi.startCodexDeviceLogin(),
    onSuccess: () => {
      setActionError(null);
      setNotice(null);
      void invalidate();
    },
    onError,
  });
  const cancelDevice = useMutation({
    mutationFn: () => aiSubscriptionsApi.cancelCodexDeviceLogin(),
    onSuccess: () => void invalidate(),
    onError,
  });
  const disconnect = useMutation({
    mutationFn: (provider: AiSubscriptionProvider) => aiSubscriptionsApi.disconnect(provider),
    onSuccess: (_data, provider) => {
      setActionError(null);
      setNotice(`${provider === "claude" ? "Claude" : "Codex"} disconnected. Issues set to your subscription will pause until you reconnect or switch them back.`);
      void invalidate();
    },
    onError,
  });

  if (mineQuery.isLoading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (mineQuery.error) return <div className="text-sm text-destructive">{errorText(mineQuery.error)}</div>;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">My AI subscriptions</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Connect your own Claude or ChatGPT plan, then pick <strong>Run with → My subscription</strong> on an issue.
          Those runs use your quota instead of the Studio's. Everything else keeps using the Studio default.
          Only you can attach your subscription to an issue, and runs triggered by other people never use it.
        </p>
      </div>

      {actionError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{actionError}</div>
      ) : null}
      {notice ? (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-sm">{notice}</div>
      ) : null}

      <ProviderCard
        title="Claude (Pro / Max)"
        description="Used by agents that run on Claude Code."
        sub={byProvider.get("claude")}
        onDisconnect={() => disconnect.mutate("claude")}
        disconnecting={disconnect.isPending}
      >
        <div className="space-y-3">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            <li>
              On your own computer, install Claude Code if needed (<code>npm i -g @anthropic-ai/claude-code</code>).
            </li>
            <li>
              Run <code className="rounded bg-muted px-1">claude setup-token</code> and sign in with your Claude account in the browser.
            </li>
            <li>
              Copy the token it prints (starts with <code>sk-ant-oat01-</code>) and paste it below. It's valid for about a year.
            </li>
          </ol>
          <div className="space-y-1.5">
            <Label htmlFor="claude-token">{byProvider.get("claude") ? "Replace token" : "Setup token"}</Label>
            <div className="flex gap-2">
              <Input
                id="claude-token"
                type="password"
                autoComplete="off"
                placeholder="sk-ant-oat01-…"
                value={claudeToken}
                onChange={(e) => setClaudeToken(e.target.value)}
              />
              <Button onClick={() => saveClaude.mutate()} disabled={!claudeToken.trim() || saveClaude.isPending}>
                {saveClaude.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : "Connect"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Stored encrypted. It's never shown again or shared with other users.</p>
          </div>
        </div>
      </ProviderCard>

      <ProviderCard
        title="Codex (ChatGPT Plus / Pro / Team)"
        description="Used by agents that run on Codex."
        sub={byProvider.get("codex")}
        onDisconnect={() => disconnect.mutate("codex")}
        disconnecting={disconnect.isPending}
      >
        <div className="space-y-3">
          {deviceState.state === "pending" ? (
            <>
              <CodexDeviceLoginPanel state={deviceState} />
              <Button variant="ghost" size="sm" onClick={() => cancelDevice.mutate()} disabled={cancelDevice.isPending}>
                Cancel
              </Button>
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => startDevice.mutate()} disabled={startDevice.isPending}>
                {startDevice.isPending ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                {byProvider.get("codex") ? "Reconnect with ChatGPT" : "Connect with ChatGPT"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setShowCodexPaste((v) => !v)}>
                {showCodexPaste ? "Hide" : "Or paste auth.json"}
              </Button>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            You'll get a link and a one-time code. Approve it in your browser. You don't need anything installed locally.
          </p>
          {showCodexPaste && deviceState.state !== "pending" ? (
            <div className="space-y-1.5">
              <Label htmlFor="codex-auth">
                Contents of <code>~/.codex/auth.json</code> (after <code>codex login</code> with ChatGPT)
              </Label>
              <Textarea
                id="codex-auth"
                rows={5}
                className="font-mono text-xs"
                value={codexAuthJson}
                onChange={(e) => setCodexAuthJson(e.target.value)}
              />
              <Button onClick={() => saveCodexJson.mutate()} disabled={!codexAuthJson.trim() || saveCodexJson.isPending}>
                Save
              </Button>
            </div>
          ) : null}
        </div>
      </ProviderCard>
    </div>
  );
}
