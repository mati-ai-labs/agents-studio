import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History, LayoutDashboard, MessageSquarePlus, RefreshCw, Settings, Trash2 } from "lucide-react";
import { Link, useNavigate, useParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { authApi } from "../api/auth";
import { routinesApi } from "../api/routines";
import { queryKeys } from "../lib/queryKeys";
import { dashboardKeys, dashboardsApi, type CompanyDashboard } from "../api/dashboards";
import { handleBridgeOp, withDashboardSdk } from "../lib/dashboard-bridge";
import { AgentSelect, fileDashboardRequest } from "./Dashboards";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------- frame

function DashboardFrame({ dashboard, html, version }: { dashboard: CompanyDashboard; html: string; version: number }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const navigate = useNavigate();
  const { data: session } = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession() });
  const user = (session as { user?: { name?: string | null; email?: string | null } } | null)?.user;
  const ctxRef = useRef({
    companyId: dashboard.companyId,
    dashboard,
    version,
    viewer: { name: user?.name ?? null, email: user?.email ?? null },
    openIssue: (identifier: string) => navigate(`/issues/${identifier}`),
  });
  ctxRef.current = {
    companyId: dashboard.companyId,
    dashboard,
    version,
    viewer: { name: user?.name ?? null, email: user?.email ?? null },
    openIssue: (identifier: string) => navigate(`/issues/${identifier}`),
  };

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const msg = event.data as { __studio?: number; id?: number; op?: string; args?: Record<string, unknown> } | null;
      if (!msg || msg.__studio !== 1 || typeof msg.id !== "number" || typeof msg.op !== "string") return;
      const reply = (payload: Record<string, unknown>) =>
        frame.contentWindow?.postMessage({ __studioReply: 1, id: msg.id, ...payload }, "*");
      handleBridgeOp(ctxRef.current, msg.op, msg.args ?? {})
        .then((result) => reply({ ok: true, result }))
        .catch((err) => reply({ ok: false, error: errorText(err) }));
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const srcDoc = useMemo(() => withDashboardSdk(html), [html]);

  return (
    <iframe
      ref={frameRef}
      data-dashboard-frame
      title={dashboard.name}
      srcDoc={srcDoc}
      // No allow-same-origin: the page gets an opaque origin and only reaches Studio through the bridge.
      sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
      className="h-full min-h-[70vh] w-full rounded-lg border border-border bg-background"
    />
  );
}

// ---------------------------------------------------------------- dialogs

function RequestChangeDialog({ dashboard, open, onOpenChange }: { dashboard: CompanyDashboard; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [text, setText] = useState("");
  const [builder, setBuilder] = useState(dashboard.builderAgentId ?? "");
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  useEffect(() => {
    if (open) setBuilder(dashboard.builderAgentId ?? "");
    else setText("");
  }, [open, dashboard.builderAgentId]);

  const submit = useMutation({
    mutationFn: async () => {
      if (builder && builder !== dashboard.builderAgentId) {
        await dashboardsApi.update(dashboard.companyId, dashboard.id, { builderAgentId: builder });
      }
      return fileDashboardRequest(dashboard.companyId, dashboard, dashboard.currentVersion ? "change" : "build", text, builder || null);
    },
    onSuccess: async (issue) => {
      await queryClient.invalidateQueries({ queryKey: dashboardKeys.requests(dashboard.companyId, dashboard.id) });
      await queryClient.invalidateQueries({ queryKey: dashboardKeys.detail(dashboard.companyId, dashboard.slug) });
      pushToast({ title: "Change requested", body: `${issue.identifier ?? "A task"} is with the builder agent.`, tone: "success" });
      onOpenChange(false);
    },
    onError: (err) => pushToast({ title: "Could not request the change", body: errorText(err), tone: "error" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Request a change</DialogTitle>
          <DialogDescription>The builder agent gets a task with your request and the current version, and publishes a new version.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a column for…, the chart should…, data is wrong for…" />
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Builder agent</span>
            <AgentSelect companyId={dashboard.companyId} value={builder} onChange={setBuilder} />
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!text.trim() || !builder || submit.isPending} onClick={() => submit.mutate()}>
            {submit.isPending ? "Sending…" : "Send to agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HistoryDialog({ dashboard, open, onOpenChange }: { dashboard: CompanyDashboard; open: boolean; onOpenChange: (v: boolean) => void }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const { companyId, id } = dashboard;
  const { data: versions } = useQuery({
    queryKey: dashboardKeys.versions(companyId, id),
    queryFn: () => dashboardsApi.versions(companyId, id),
    enabled: open,
  });
  const { data: requests } = useQuery({
    queryKey: dashboardKeys.requests(companyId, id),
    queryFn: () => dashboardsApi.requests(companyId, id),
    enabled: open,
  });
  const activate = useMutation({
    mutationFn: (version: number) => dashboardsApi.activateVersion(companyId, id, version),
    onSuccess: async (_row, version) => {
      await queryClient.invalidateQueries({ queryKey: ["dashboards", companyId] });
      pushToast({ title: `v${version} is live`, tone: "success" });
    },
    onError: (err) => pushToast({ title: "Could not switch versions", body: errorText(err), tone: "error" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>History</DialogTitle>
          <DialogDescription>Published versions and the requests behind them. Switch back to any version.</DialogDescription>
        </DialogHeader>
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground">Versions</h3>
          {(versions ?? []).length === 0 ? <p className="text-sm text-muted-foreground">Nothing published yet.</p> : null}
          {(versions ?? []).map((v) => (
            <div key={v.id} className="flex items-start justify-between gap-3 rounded-md border border-border p-2 text-sm">
              <div className="min-w-0">
                <div className="font-medium">
                  v{v.version}
                  {v.version === dashboard.currentVersion ? <span className="ml-2 text-xs text-primary">live</span> : null}
                  {v.issueIdentifier ? (
                    <Link to={`/issues/${v.issueIdentifier}`} className="ml-2 text-xs text-primary underline">{v.issueIdentifier}</Link>
                  ) : null}
                </div>
                {v.note ? <p className="text-muted-foreground">{v.note}</p> : null}
                <p className="text-xs text-muted-foreground">{new Date(v.createdAt).toLocaleString()} · {(v.byteSize / 1024).toFixed(0)} KB</p>
              </div>
              {v.version !== dashboard.currentVersion ? (
                <Button size="sm" variant="outline" disabled={activate.isPending} onClick={() => activate.mutate(v.version)}>
                  Make live
                </Button>
              ) : null}
            </div>
          ))}
        </section>
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground">Requests</h3>
          {(requests ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No requests yet.</p> : null}
          {(requests ?? []).map((r) => (
            <div key={r.id} className="rounded-md border border-border p-2 text-sm">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{r.kind === "build" ? "Build" : "Change"}</span>
                {r.issueIdentifier ? <Link to={`/issues/${r.issueIdentifier}`} className="text-primary underline">{r.issueIdentifier}</Link> : null}
                {r.issueStatus ? <span>{r.issueStatus.replace(/_/g, " ")}</span> : null}
                <span>{new Date(r.createdAt).toLocaleString()}</span>
              </div>
              <p className="mt-1 line-clamp-3 whitespace-pre-wrap">{r.request}</p>
            </div>
          ))}
        </section>
      </DialogContent>
    </Dialog>
  );
}

function SettingsDialog({ dashboard, open, onOpenChange }: { dashboard: CompanyDashboard; open: boolean; onOpenChange: (v: boolean) => void }) {
  const { companyId, id } = dashboard;
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [name, setName] = useState(dashboard.name);
  const [description, setDescription] = useState(dashboard.description ?? "");
  const [emails, setEmails] = useState((dashboard.allowedEmails ?? []).join(", "));
  const [builder, setBuilder] = useState(dashboard.builderAgentId ?? "");
  const [routineIds, setRoutineIds] = useState<string[]>(dashboard.allowedRoutineIds ?? []);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(dashboard.name);
    setDescription(dashboard.description ?? "");
    setEmails((dashboard.allowedEmails ?? []).join(", "));
    setBuilder(dashboard.builderAgentId ?? "");
    setRoutineIds(dashboard.allowedRoutineIds ?? []);
    setToken(null);
  }, [open, dashboard]);

  const { data: routines } = useQuery({
    queryKey: ["routines", companyId],
    queryFn: () => routinesApi.list(companyId),
    enabled: open,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["dashboards", companyId] });
  const save = useMutation({
    mutationFn: () =>
      dashboardsApi.update(companyId, id, {
        name,
        description,
        allowedEmails: emails.trim() ? emails.split(/[\s,;]+/).filter(Boolean) : null,
        builderAgentId: builder || null,
        allowedRoutineIds: routineIds,
      }),
    onSuccess: async () => {
      await invalidate();
      pushToast({ title: "Settings saved", tone: "success" });
      onOpenChange(false);
    },
    onError: (err) => pushToast({ title: "Could not save", body: errorText(err), tone: "error" }),
  });
  const rotate = useMutation({
    mutationFn: () => dashboardsApi.rotateIngestToken(companyId, id),
    onSuccess: async (res) => {
      setToken(res.token);
      await invalidate();
    },
    onError: (err) => pushToast({ title: "Could not create a token", body: errorText(err), tone: "error" }),
  });
  const revoke = useMutation({
    mutationFn: () => dashboardsApi.revokeIngestToken(companyId, id),
    onSuccess: async () => {
      setToken(null);
      await invalidate();
      pushToast({ title: "Ingest token revoked", tone: "success" });
    },
  });
  const ingestUrl = `${window.location.origin}/api/companies/${companyId}/dashboards/${id}/ingest`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Dashboard settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Description</span>
            <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Who can see it</span>
            <Input value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="Everyone in the company" />
            <span className="block text-xs text-muted-foreground">Comma-separated emails. Leave empty for every board member. Instance admins always see it.</span>
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Builder agent</span>
            <AgentSelect companyId={companyId} value={builder} onChange={setBuilder} />
          </label>
          <div className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Routines the dashboard may run</span>
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-2">
              {(routines ?? []).length === 0 ? <p className="text-xs text-muted-foreground">No routines in this company.</p> : null}
              {(routines ?? []).map((routine) => (
                <label key={routine.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={routineIds.includes(routine.id)}
                    onChange={(e) =>
                      setRoutineIds((prev) => (e.target.checked ? [...prev, routine.id] : prev.filter((r) => r !== routine.id)))
                    }
                  />
                  <span className="truncate">{routine.title}</span>
                  <code className="ml-auto shrink-0 text-[10px] text-muted-foreground">{routine.id.slice(0, 8)}</code>
                </label>
              ))}
            </div>
          </div>
          <div className="space-y-2 rounded-md border border-border p-3">
            <div className="text-xs font-medium text-muted-foreground">Ingest token (for Apps Script, cron jobs and other systems)</div>
            <code className="block break-all text-xs">POST {ingestUrl}</code>
            {token ? (
              <div className="space-y-1">
                <code className="block break-all rounded bg-muted p-2 text-xs">{token}</code>
                <span className="block text-xs text-muted-foreground">Copy it now. It isn't shown again.</span>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{dashboard.hasIngestToken ? "A token is active." : "No token yet."}</p>
            )}
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={rotate.isPending} onClick={() => rotate.mutate()}>
                {dashboard.hasIngestToken ? "Replace token" : "Create token"}
              </Button>
              {dashboard.hasIngestToken ? (
                <Button size="sm" variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate()}>Revoke</Button>
              ) : null}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ dashboard, open, onOpenChange }: { dashboard: CompanyDashboard; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [confirm, setConfirm] = useState("");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  useEffect(() => {
    if (!open) setConfirm("");
  }, [open]);
  const remove = useMutation({
    mutationFn: () => dashboardsApi.remove(dashboard.companyId, dashboard.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["dashboards", dashboard.companyId] });
      pushToast({ title: `${dashboard.name} deleted`, tone: "success" });
      navigate("/dashboards");
    },
    onError: (err) => pushToast({ title: "Could not delete", body: errorText(err), tone: "error" }),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {dashboard.name}?</DialogTitle>
          <DialogDescription>
            This permanently removes the dashboard, every version, its data and its files. Tasks filed for it stay.
          </DialogDescription>
        </DialogHeader>
        <label className="block space-y-1 text-sm">
          <span className="text-xs text-muted-foreground">Type <b>{dashboard.slug}</b> to confirm</span>
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="destructive" disabled={confirm.trim() !== dashboard.slug || remove.isPending} onClick={() => remove.mutate()}>
            {remove.isPending ? "Deleting…" : "Delete dashboard"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- page

export function DashboardView() {
  const { dashboardId } = useParams<{ dashboardId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [dialog, setDialog] = useState<null | "change" | "history" | "settings" | "delete">(null);
  const [frameKey, setFrameKey] = useState(0);
  const companyId = selectedCompanyId ?? "";

  const { data: dashboard, isLoading, error } = useQuery({
    queryKey: dashboardKeys.detail(companyId, dashboardId ?? ""),
    queryFn: () => dashboardsApi.get(companyId, dashboardId!),
    enabled: !!selectedCompanyId && !!dashboardId,
    // Pick up versions the agent publishes while you watch.
    refetchInterval: 15_000,
  });
  const version = dashboard?.currentVersion ?? null;
  const { data: page, isLoading: pageLoading } = useQuery({
    queryKey: dashboardKeys.html(companyId, dashboard?.id ?? "", version),
    queryFn: () => dashboardsApi.html(companyId, dashboard!.id),
    enabled: !!dashboard && !!version,
    staleTime: Infinity,
  });
  const { data: requests } = useQuery({
    queryKey: dashboardKeys.requests(companyId, dashboard?.id ?? ""),
    queryFn: () => dashboardsApi.requests(companyId, dashboard!.id),
    enabled: !!dashboard,
    refetchInterval: 30_000,
  });
  const openRequests = (requests ?? []).filter((r) => r.issueStatus && !["done", "cancelled"].includes(r.issueStatus));

  useEffect(() => {
    setBreadcrumbs([{ label: "Dashboards", href: "/dashboards" }, { label: dashboard?.name ?? "…" }]);
  }, [setBreadcrumbs, dashboard?.name]);

  const refresh = useCallback(() => {
    const frame = document.querySelector<HTMLIFrameElement>("iframe[data-dashboard-frame]");
    frame?.contentWindow?.postMessage({ __studioEvent: "refresh" }, "*");
    if (!frame) setFrameKey((k) => k + 1);
  }, []);

  if (!selectedCompanyId || isLoading) return <PageSkeleton />;
  if (error || !dashboard) {
    return <EmptyState icon={LayoutDashboard} message={error ? errorText(error) : "Dashboard not found."} />;
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">{dashboard.name}</h1>
          <p className="text-xs text-muted-foreground">
            {version ? `v${version}` : "Not published yet"}
            {openRequests.length > 0 ? (
              <>
                {" · "}
                {openRequests.map((r, i) => (
                  <span key={r.id}>
                    {i > 0 ? ", " : ""}
                    <Link to={`/issues/${r.issueIdentifier ?? r.issueId}`} className="text-primary underline">
                      {r.issueIdentifier ?? "request"}
                    </Link>
                    {" "}{r.issueStatus?.replace(/_/g, " ")}
                  </span>
                ))}
              </>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" onClick={refresh} disabled={!version} title="Reload the dashboard's data">
            <RefreshCw className="mr-1 h-4 w-4" /> Refresh
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDialog("change")}>
            <MessageSquarePlus className="mr-1 h-4 w-4" /> Request change
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDialog("history")}>
            <History className="mr-1 h-4 w-4" /> History
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDialog("settings")}>
            <Settings className="mr-1 h-4 w-4" /> Settings
          </Button>
          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDialog("delete")}>
            <Trash2 className="mr-1 h-4 w-4" /> Delete
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {!version ? (
          <EmptyState
            icon={LayoutDashboard}
            message={
              openRequests.length > 0
                ? `The builder agent is working on it (${openRequests[0]!.issueIdentifier ?? "task"}). It shows up here when the first version is published.`
                : "Nothing published yet. Request a build to get started."
            }
            action={openRequests.length > 0 ? undefined : "Request build"}
            onAction={openRequests.length > 0 ? undefined : () => setDialog("change")}
          />
        ) : pageLoading || !page ? (
          <PageSkeleton />
        ) : (
          <DashboardFrame key={`${page.version}-${frameKey}`} dashboard={dashboard} html={page.html} version={page.version} />
        )}
      </div>
      <RequestChangeDialog dashboard={dashboard} open={dialog === "change"} onOpenChange={(v) => setDialog(v ? "change" : null)} />
      <HistoryDialog dashboard={dashboard} open={dialog === "history"} onOpenChange={(v) => setDialog(v ? "history" : null)} />
      <SettingsDialog dashboard={dashboard} open={dialog === "settings"} onOpenChange={(v) => setDialog(v ? "settings" : null)} />
      <DeleteDialog dashboard={dashboard} open={dialog === "delete"} onOpenChange={(v) => setDialog(v ? "delete" : null)} />
    </div>
  );
}
