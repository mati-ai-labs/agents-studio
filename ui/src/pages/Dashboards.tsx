import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LayoutDashboard, Plus } from "lucide-react";
import { Link, useNavigate } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { dashboardKeys, dashboardsApi, type CompanyDashboard } from "../api/dashboards";

/** Files the builder issue for a dashboard request and links it to the dashboard. */
export async function fileDashboardRequest(
  companyId: string,
  dashboard: Pick<CompanyDashboard, "id">,
  kind: "build" | "change",
  request: string,
  assigneeAgentId: string | null,
) {
  const draft = await dashboardsApi.draftRequest(companyId, dashboard.id, { kind, request });
  const assignee = assigneeAgentId ?? draft.assigneeAgentId;
  const issue = await issuesApi.create(companyId, {
    title: draft.title,
    description: draft.description,
    ...(assignee ? { assigneeAgentId: assignee, status: "todo" } : {}),
  });
  await dashboardsApi.recordRequest(companyId, dashboard.id, { kind, request, issueId: issue.id });
  return issue;
}

export function useBuilderAgents(companyId: string | null | undefined) {
  const { data: agents } = useQuery({
    queryKey: ["agents", companyId],
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId,
  });
  return useMemo(
    () => (agents ?? []).filter((a) => (a as { status?: string }).status !== "terminated").sort((a, b) => a.name.localeCompare(b.name)),
    [agents],
  );
}

export function AgentSelect({ value, onChange, companyId }: { value: string; onChange: (v: string) => void; companyId: string }) {
  const agents = useBuilderAgents(companyId);
  return (
    <select
      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">Choose an agent…</option>
      {agents.map((agent) => (
        <option key={agent.id} value={agent.id}>
          {agent.name}
        </option>
      ))}
    </select>
  );
}

function NewDashboardDialog({ open, onOpenChange, companyId }: { open: boolean; onOpenChange: (v: boolean) => void; companyId: string }) {
  const [name, setName] = useState("");
  const [request, setRequest] = useState("");
  const [builder, setBuilder] = useState("");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  useEffect(() => {
    if (!open) {
      setName("");
      setRequest("");
    }
  }, [open]);

  const create = useMutation({
    mutationFn: async () => {
      const dashboard = await dashboardsApi.create(companyId, {
        name: name.trim(),
        description: request.trim().split("\n")[0]?.slice(0, 280),
        builderAgentId: builder || null,
      });
      const issue = await fileDashboardRequest(companyId, dashboard, "build", request, builder || null);
      return { dashboard, issue };
    },
    onSuccess: async ({ dashboard, issue }) => {
      await queryClient.invalidateQueries({ queryKey: dashboardKeys.list(companyId) });
      pushToast({ title: "Dashboard requested", body: `${issue.identifier ?? "A task"} was created for the builder agent.`, tone: "success" });
      onOpenChange(false);
      navigate(`/dashboards/${dashboard.slug}`);
    },
    onError: (err) => pushToast({ title: "Could not create the dashboard", body: err instanceof Error ? err.message : String(err), tone: "error" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New dashboard</DialogTitle>
          <DialogDescription>
            Describe what you want to see. An agent builds it, loads the data and publishes it here.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Sales pipeline" />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">What should it show?</span>
            <Textarea
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              rows={6}
              placeholder="Where the data comes from, the views and charts you need, filters, who uses it…"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Builder agent</span>
            <AgentSelect companyId={companyId} value={builder} onChange={setBuilder} />
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!name.trim() || !request.trim() || !builder || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Creating…" : "Create and request build"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function Dashboards() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [open, setOpen] = useState(false);
  useEffect(() => setBreadcrumbs([{ label: "Dashboards" }]), [setBreadcrumbs]);

  const { data, isLoading } = useQuery({
    queryKey: dashboardKeys.list(selectedCompanyId!),
    queryFn: () => dashboardsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId || isLoading) return <PageSkeleton />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Dashboards</h1>
          <p className="text-sm text-muted-foreground">Live dashboards your agents build and keep up to date.</p>
        </div>
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus className="mr-1 h-4 w-4" /> New dashboard
        </Button>
      </div>
      {!data || data.length === 0 ? (
        <EmptyState icon={LayoutDashboard} message="No dashboards yet." action="New dashboard" onAction={() => setOpen(true)} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {data.map((dashboard) => (
            <Link
              key={dashboard.id}
              to={`/dashboards/${dashboard.slug}`}
              className="block rounded-lg border border-border p-4 transition-colors hover:bg-accent/40"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{dashboard.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {dashboard.currentVersion ? `v${dashboard.currentVersion}` : "Being built"}
                </span>
              </div>
              {dashboard.description ? (
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{dashboard.description}</p>
              ) : null}
              <p className="mt-2 text-xs text-muted-foreground">Updated {new Date(dashboard.updatedAt).toLocaleString()}</p>
            </Link>
          ))}
        </div>
      )}
      <NewDashboardDialog open={open} onOpenChange={setOpen} companyId={selectedCompanyId} />
    </div>
  );
}
