import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Hash, Trash2 } from "lucide-react";
import { api } from "@/api/client";
import { Button } from "../components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useBreadcrumbs } from "../context/BreadcrumbContext";

interface SlackWorkspace {
  connectorId: string;
  connectedViaCompanyName: string;
  workspaceId: string;
  workspaceName: string;
}
interface SlackRoute {
  id: string;
  connectorId: string;
  channelId: string;
  channelName: string;
  companyId: string;
  companyName: string | null;
  assigneeAgentId: string;
  assigneeAgentName: string | null;
  enabled: boolean;
}
interface SlackSettingsView {
  workspaces: SlackWorkspace[];
  companies: Array<{ id: string; name: string }>;
  routes: SlackRoute[];
}

const KEY = ["instance", "slack-settings"] as const;

const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm disabled:opacity-50";

export function InstanceSlackSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [connectorId, setConnectorId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Instance Settings" }, { label: "Slack" }]);
  }, [setBreadcrumbs]);

  const settings = useQuery({
    queryKey: KEY,
    queryFn: () => api.get<SlackSettingsView>("/instance/settings/slack"),
  });

  useEffect(() => {
    const first = settings.data?.workspaces[0]?.connectorId;
    if (!connectorId && first) setConnectorId(first);
  }, [settings.data, connectorId]);

  const channels = useQuery({
    queryKey: [...KEY, "channels", connectorId],
    queryFn: () =>
      api.get<{ channels: Array<{ id: string; name: string; isMember: boolean }> }>(
        `/instance/settings/slack/channels?connectorId=${encodeURIComponent(connectorId)}`,
      ),
    enabled: Boolean(connectorId),
  });

  const agents = useQuery({
    queryKey: [...KEY, "agents", companyId],
    queryFn: () =>
      api.get<{ agents: Array<{ id: string; name: string; title: string | null }> }>(
        `/instance/settings/slack/companies/${companyId}/agents`,
      ),
    enabled: Boolean(companyId),
  });

  const onError = (err: unknown) => setError(err instanceof Error ? err.message : "Request failed");
  const refresh = () => {
    setError(null);
    return queryClient.invalidateQueries({ queryKey: KEY });
  };

  const save = useMutation({
    mutationFn: () =>
      api.put("/instance/settings/slack/routes", { connectorId, channelId, companyId, assigneeAgentId: agentId }),
    onSuccess: async () => {
      setChannelId("");
      setAgentId("");
      await refresh();
    },
    onError,
  });
  const toggle = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      api.patch(`/instance/settings/slack/routes/${input.id}`, { enabled: input.enabled }),
    onSuccess: refresh,
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/instance/settings/slack/routes/${id}`),
    onSuccess: refresh,
    onError,
  });

  if (settings.isLoading) return <div className="text-sm text-muted-foreground">Loading Slack settings...</div>;
  if (settings.error || !settings.data) {
    return (
      <div className="text-sm text-destructive">
        {settings.error instanceof Error ? settings.error.message : "Failed to load Slack settings."}
      </div>
    );
  }

  const data = settings.data;
  const existing = data.routes.find((r) => r.channelId === channelId && r.connectorId === connectorId);
  const selectedChannel = channels.data?.channels.find((c) => c.id === channelId);

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Hash className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Slack</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Map a Slack channel to a company and one of its agents. Mentioning the bot in that channel creates an issue
          for the agent, and replies go back to the thread. One channel maps to one company.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {data.workspaces.length === 0 ? (
        <section className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
          No Slack workspace is connected. Connect Slack from any company's Connectors page first.
        </section>
      ) : (
        <section className="rounded-xl border border-border bg-card p-5 space-y-4">
          <h2 className="text-sm font-semibold">Add or change a mapping</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {data.workspaces.length > 1 && (
              <label className="space-y-1 text-sm md:col-span-2">
                <span className="text-muted-foreground">Workspace</span>
                <select className={selectClass} value={connectorId} onChange={(e) => { setConnectorId(e.target.value); setChannelId(""); }}>
                  {data.workspaces.map((w) => (
                    <option key={w.connectorId} value={w.connectorId}>
                      {w.workspaceName} (connected via {w.connectedViaCompanyName})
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Channel</span>
              <select className={selectClass} value={channelId} onChange={(e) => setChannelId(e.target.value)} disabled={channels.isLoading}>
                <option value="">{channels.isLoading ? "Loading channels..." : "Pick a channel"}</option>
                {channels.data?.channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.name}{c.isMember ? "" : " (bot not in channel)"}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Company</span>
              <select className={selectClass} value={companyId} onChange={(e) => { setCompanyId(e.target.value); setAgentId(""); }}>
                <option value="">Pick a company</option>
                {data.companies.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm md:col-span-2">
              <span className="text-muted-foreground">Agent</span>
              <select className={selectClass} value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={!companyId || agents.isLoading}>
                <option value="">{companyId ? "Pick an agent" : "Pick a company first"}</option>
                {agents.data?.agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.title ? `${a.name} — ${a.title}` : a.name}</option>
                ))}
              </select>
            </label>
          </div>
          {selectedChannel && !selectedChannel.isMember && (
            <p className="text-sm text-muted-foreground">
              Invite the bot to #{selectedChannel.name} first: type <code>/invite @&lt;bot name&gt;</code> in the channel.
            </p>
          )}
          {existing && (
            <p className="text-sm text-muted-foreground">
              #{existing.channelName} is mapped to {existing.companyName} → {existing.assigneeAgentName}. Saving replaces it.
            </p>
          )}
          <Button size="sm" disabled={!channelId || !companyId || !agentId || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving..." : existing ? "Replace mapping" : "Add mapping"}
          </Button>
        </section>
      )}

      <section className="rounded-xl border border-border bg-card p-5 space-y-3">
        <h2 className="text-sm font-semibold">Channel mappings</h2>
        {data.routes.length === 0 ? (
          <div className="text-sm text-muted-foreground">No channels mapped yet.</div>
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border">
            {data.routes.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0 text-sm">
                  <span className="font-medium">#{r.channelName}</span>
                  <span className="text-muted-foreground"> → {r.companyName ?? r.companyId} → {r.assigneeAgentName ?? "unknown agent"}</span>
                </div>
                <div className="flex items-center gap-2">
                  <ToggleSwitch
                    checked={r.enabled}
                    onCheckedChange={(checked) => toggle.mutate({ id: r.id, enabled: checked })}
                    disabled={toggle.isPending}
                    aria-label={`Toggle #${r.channelName}`}
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove #${r.channelName}`}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(r.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
