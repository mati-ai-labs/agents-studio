import { useEffect, useMemo } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { dashboardApi } from "../api/dashboard";
import { activityApi } from "../api/activity";
import { accessApi } from "../api/access";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { buildCompanyUserProfileMap } from "../lib/company-members";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { Identity } from "../components/Identity";
import { timeAgo } from "../lib/timeAgo";
import { formatCents } from "../lib/utils";
import { formatActivityVerb } from "../lib/activity-format";
import { Bot, LayoutDashboard, Search, SlidersHorizontal } from "lucide-react";
import { PageSkeleton } from "../components/PageSkeleton";
import type { ActivityEvent, Agent, Issue } from "@paperclipai/shared";

const DASHBOARD_ACTIVITY_LIMIT = 10;
const DASHBOARD_CARD_LIMIT = 12;

function getRecentIssues(issues: Issue[]): Issue[] {
  return [...issues]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function activityEntityLink(event: ActivityEvent, entityName: string | null): string | null {
  switch (event.entityType) {
    case "issue":
      return `/issues/${entityName ?? event.entityId}`;
    case "agent":
      return `/agents/${event.entityId}`;
    case "project":
      return `/projects/${event.entityId}`;
    case "goal":
      return `/goals/${event.entityId}`;
    case "approval":
      return `/approvals/${event.entityId}`;
    default:
      return null;
  }
}

function statusTone(status: Issue["status"]): string {
  switch (status) {
    case "in_progress":
      return "pc-dashboard-status pc-dashboard-status-running";
    case "blocked":
      return "pc-dashboard-status pc-dashboard-status-blocked";
    case "in_review":
      return "pc-dashboard-status pc-dashboard-status-review";
    case "done":
      return "pc-dashboard-status pc-dashboard-status-done";
    case "cancelled":
      return "pc-dashboard-status pc-dashboard-status-muted";
    default:
      return "pc-dashboard-status pc-dashboard-status-active";
  }
}

function statusLabel(status: Issue["status"]): string {
  return status.replaceAll("_", " ");
}

export function Dashboard() {
  const { selectedCompanyId, companies } = useCompany();
  const { openOnboarding } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Dashboard" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.dashboard(selectedCompanyId!),
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: activity } = useQuery({
    queryKey: [...queryKeys.activity(selectedCompanyId!), { limit: DASHBOARD_ACTIVITY_LIMIT }],
    queryFn: () => activityApi.list(selectedCompanyId!, { limit: DASHBOARD_ACTIVITY_LIMIT }),
    enabled: !!selectedCompanyId,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );

  const recentIssues = issues ? getRecentIssues(issues) : [];
  const recentActivity = useMemo(() => (activity ?? []).slice(0, DASHBOARD_ACTIVITY_LIMIT), [activity]);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.identifier ?? i.id.slice(0, 8));
    for (const a of agents ?? []) map.set(`agent:${a.id}`, a.name);
    return map;
  }, [issues, agents]);

  const contextIssues = useMemo(
    () => recentIssues
      .filter((issue) => issue.status !== "done" && issue.status !== "cancelled")
      .slice(0, DASHBOARD_CARD_LIMIT),
    [recentIssues],
  );

  const topAssignee = useMemo(() => {
    const counts = new Map<string, number>();
    for (const issue of contextIssues) {
      if (!issue.assigneeAgentId) continue;
      counts.set(issue.assigneeAgentId, (counts.get(issue.assigneeAgentId) ?? 0) + 1);
    }
    const winner = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return winner ? agentMap.get(winner[0]) : null;
  }, [agentMap, contextIssues]);

  if (!selectedCompanyId) {
    if (companies.length === 0) {
      return (
        <EmptyState
          icon={LayoutDashboard}
          message="Welcome to Agent Studio. Set up your first company and agent to get started."
          action="Get Started"
          onAction={openOnboarding}
        />
      );
    }
    return (
      <EmptyState icon={LayoutDashboard} message="Create or select a company to view the dashboard." />
    );
  }

  if (isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  const hasNoAgents = agents !== undefined && agents.length === 0;
  const monthSpend = data ? formatCents(data.costs.monthSpendCents) : "$0.00";
  const monthBudget = data?.costs.monthBudgetCents ?? 0;

  return (
    <div className="space-y-5">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {hasNoAgents && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <Bot className="h-4 w-4 shrink-0 text-amber-600" />
            <p className="text-sm text-amber-900 dark:text-amber-100">
              You have no agents.
            </p>
          </div>
          <button
            onClick={() => openOnboarding({ initialStep: 2, companyId: selectedCompanyId! })}
            className="shrink-0 text-sm font-medium text-amber-700 underline underline-offset-2 hover:text-amber-900"
          >
            Create one here
          </button>
        </div>
      )}

      {data && (
        <div className="pc-dashboard-shell">
          <div className="pc-dashboard-topbar">
            <div className="pc-dashboard-search">
              <Search className="h-4 w-4 text-muted-foreground" />
              <span>Search</span>
            </div>
            <div className="flex items-center gap-2">
              <Link to="/search" className="pc-dashboard-top-action">Open Search</Link>
              <Link to="/inbox" className="pc-dashboard-top-action">Inbox</Link>
            </div>
          </div>

          <div className="pc-dashboard-body">
            <section className="pc-dashboard-main">
              <div className="pc-dashboard-main-header">
                <h2 className="pc-dashboard-main-title">Context Panel</h2>
                <Link to="/issues" className="pc-dashboard-subtle-link">
                  All issues
                </Link>
              </div>
              {contextIssues.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border bg-card/70 px-4 py-8 text-center text-sm text-muted-foreground">
                  No active issues yet. Create one from the sidebar.
                </div>
              ) : (
                <div className="pc-dashboard-card-grid">
                  {contextIssues.map((issue) => {
                    const assignee = issue.assigneeAgentId ? agentMap.get(issue.assigneeAgentId) : null;
                    const assigneeLabel = assignee?.name ?? "Unassigned";
                    return (
                      <Link
                        key={issue.id}
                        to={`/issues/${issue.identifier ?? issue.id}`}
                        className="pc-dashboard-agent-card"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <Identity
                            name={assigneeLabel}
                            size="sm"
                            className="min-w-0 [&>span:last-child]:font-semibold [&>span:last-child]:text-sm"
                          />
                          <span className={statusTone(issue.status)}>{statusLabel(issue.status)}</span>
                        </div>
                        <p className="mt-3 line-clamp-2 text-sm font-medium text-foreground">{issue.title}</p>
                        <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span className="font-mono">{issue.identifier ?? issue.id.slice(0, 8)}</span>
                          <span>{timeAgo(issue.updatedAt)}</span>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}
            </section>

            <aside className="pc-dashboard-right-rail">
              <section className="pc-dashboard-rail-block">
                <div className="pc-dashboard-rail-title-row">
                  <h3 className="pc-dashboard-rail-title">Live Thread</h3>
                  <Link to="/activity" className="pc-dashboard-subtle-link">
                    Activity
                  </Link>
                </div>
                <div className="pc-dashboard-thread-list">
                  {recentActivity.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No recent activity.</p>
                  ) : (
                    recentActivity.slice(0, 6).map((event) => {
                      const actor = event.actorType === "agent" ? agentMap.get(event.actorId) : null;
                      const userProfile = event.actorType === "user" ? userProfileMap.get(event.actorId) : null;
                      const actorName = actor?.name
                        ?? (event.actorType === "user" ? (userProfile?.label ?? "Board") : event.actorType === "system" ? "System" : "Plugin");
                      const verb = formatActivityVerb(event.action, event.details, { agentMap, userProfileMap });
                      const entityName = entityNameMap.get(`${event.entityType}:${event.entityId}`) ?? null;
                      const link = activityEntityLink(event, entityName);

                      return (
                        <div key={event.id} className="pc-dashboard-thread-item">
                          <div className="flex items-center justify-between gap-2">
                            <Identity name={actorName} avatarUrl={userProfile?.image} size="xs" />
                            <span className="text-[11px] text-muted-foreground">{timeAgo(event.createdAt)}</span>
                          </div>
                          {link ? (
                            <Link to={link} className="pc-dashboard-thread-bubble">
                              {verb}
                            </Link>
                          ) : (
                            <p className="pc-dashboard-thread-bubble">{verb}</p>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </section>

              <section className="pc-dashboard-rail-block">
                <div className="pc-dashboard-rail-title-row">
                  <h3 className="pc-dashboard-rail-title">Properties</h3>
                  <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="pc-dashboard-properties-grid">
                  <Link to="/costs" className="pc-dashboard-property-tile">
                    <span className="pc-dashboard-property-label">Status</span>
                    <span className="pc-dashboard-property-value">
                      {data.budgets.activeIncidents > 0 ? "Attention" : "Healthy"}
                    </span>
                  </Link>
                  <Link to="/issues" className="pc-dashboard-property-tile">
                    <span className="pc-dashboard-property-label">Priority</span>
                    <span className="pc-dashboard-property-value">
                      {data.tasks.blocked > 0 ? "Blocked work" : "In progress"}
                    </span>
                  </Link>
                  <Link to="/costs" className="pc-dashboard-property-tile">
                    <span className="pc-dashboard-property-label">Spend</span>
                    <span className="pc-dashboard-property-value">
                      {monthBudget > 0 ? `${data.costs.monthUtilizationPercent}%` : monthSpend}
                    </span>
                    {monthBudget > 0 ? (
                      <span className="pc-dashboard-property-note">
                        {monthSpend} / {formatCents(monthBudget)}
                      </span>
                    ) : null}
                  </Link>
                  <Link to="/agents" className="pc-dashboard-property-tile">
                    <span className="pc-dashboard-property-label">Assignee</span>
                    <span className="pc-dashboard-property-value">
                      {topAssignee?.name ?? "Unassigned"}
                    </span>
                    <span className="pc-dashboard-property-note">
                      {data.agents.running} agents running
                    </span>
                  </Link>
                </div>
              </section>
            </aside>
          </div>
        </div>
      )}
    </div>
  );
}
