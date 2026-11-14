import { useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, Play } from "lucide-react";
import type { EvalCohortComparison, EvalCohortSummary } from "@paperclipai/shared";
import { evalsApi, type ClassifierDecision, type ClassifierRun, type EvalResultRow } from "../api/evals";
import { ApiError } from "../api/client";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";

export const CLASSIFIER_SCENARIO_ID = "guardrail_classifier.benchmark";

const DECISION_LABELS: Record<ClassifierDecision, string> = {
  allow: "Allow",
  deny: "Block",
  approval: "Needs approval",
  error: "Error",
};

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
}

function dollars(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? "—" : `$${(cents / 100).toFixed(cents < 100 ? 3 : 2)}`;
}

function compactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function DecisionBadge({ decision }: { decision: ClassifierDecision }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium",
        decision === "allow" && "bg-muted text-muted-foreground",
        decision === "deny" && "bg-destructive/15 text-destructive",
        decision === "approval" && "bg-amber-500/15 text-amber-700 dark:text-amber-400",
        decision === "error" && "bg-destructive/15 text-destructive",
      )}
    >
      {DECISION_LABELS[decision]}
    </span>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("text-lg font-semibold tabular-nums", tone === "bad" && "text-destructive", tone === "good" && "text-emerald-600 dark:text-emerald-400")}>
        {value}
      </div>
    </div>
  );
}

/** A classifier run as the page shows it: a fresh POST result, or rebuilt from a stored eval result. */
export interface ClassifierRunView {
  evaluatedAt: string;
  model: string;
  passed: boolean;
  accuracy: number;
  correct: number;
  total: number;
  missed: number;
  falseStops: number;
  wrongKind: number;
  errors: number;
  cases: Array<{ id: string; action: string; expect: ClassifierDecision; decision: ClassifierDecision; ok: boolean; ruleName: string | null; reason: string }>;
}

export function viewFromRun(run: ClassifierRun): ClassifierRunView {
  return {
    evaluatedAt: run.evaluatedAt,
    model: run.model,
    passed: run.passed,
    accuracy: run.summary.accuracy,
    correct: run.summary.correct,
    total: run.summary.total,
    missed: run.summary.missed,
    falseStops: run.summary.falseStops,
    wrongKind: run.summary.wrongKind,
    errors: run.summary.errors,
    cases: run.results.map((result) => ({
      id: result.id,
      action: result.action,
      expect: result.expect,
      decision: result.decision,
      ok: result.ok,
      ruleName: result.ruleName,
      reason: result.reason,
    })),
  };
}

export function viewFromStoredResult(row: EvalResultRow): ClassifierRunView {
  const cases = row.checks.map((check) => {
    const observed = check.observed ?? {};
    const expect = (observed.expect as ClassifierDecision) ?? "allow";
    const decision = (observed.decision as ClassifierDecision) ?? "error";
    const reasonMatch = /—\s*(.*)$/.exec(check.detail);
    return {
      id: check.name,
      action: typeof observed.action === "string" ? observed.action : check.name,
      expect,
      decision,
      ok: check.passed,
      ruleName: typeof observed.ruleName === "string" ? observed.ruleName : null,
      reason: reasonMatch?.[1] ?? "",
    };
  });
  let missed = 0;
  let falseStops = 0;
  let wrongKind = 0;
  let errors = 0;
  for (const entry of cases) {
    if (entry.ok) continue;
    if (entry.decision === "error") errors += 1;
    else if (entry.expect !== "allow" && entry.decision === "allow") missed += 1;
    else if (entry.expect === "allow") falseStops += 1;
    else wrongKind += 1;
  }
  return {
    evaluatedAt: row.evaluatedAt,
    model: row.bundleId.replace(/^classifier\./, ""),
    passed: row.status === "passed",
    accuracy: row.score,
    correct: cases.filter((entry) => entry.ok).length,
    total: cases.length,
    missed,
    falseStops,
    wrongKind,
    errors,
    cases,
  };
}

function ClassifierResults({ view }: { view: ClassifierRunView }) {
  const [showAll, setShowAll] = useState(false);
  const failed = view.cases.filter((entry) => !entry.ok);
  const shown = showAll ? [...failed, ...view.cases.filter((entry) => entry.ok)] : failed;
  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground">
        {view.passed ? "Passed" : "Failed"} · model {view.model} · {relativeTime(view.evaluatedAt)}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Stat label="Accuracy" value={`${percent(view.accuracy)} (${view.correct}/${view.total})`} tone={view.accuracy >= 0.9 ? "good" : "bad"} />
        <Stat label="Missed (should stop, allowed)" value={String(view.missed)} tone={view.missed > 0 ? "bad" : "good"} />
        <Stat label="Wrong blocks (normal work stopped)" value={String(view.falseStops)} tone={view.falseStops > 0 ? "bad" : "good"} />
        <Stat label="Block vs approval mixed up" value={String(view.wrongKind)} tone={view.wrongKind > 0 ? "bad" : undefined} />
        <Stat label="Errors" value={String(view.errors)} tone={view.errors > 0 ? "bad" : undefined} />
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">Every case got the expected decision.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Case</th>
                <th className="px-3 py-2 font-medium">Agent action</th>
                <th className="px-3 py-2 font-medium">Expected</th>
                <th className="px-3 py-2 font-medium">Got</th>
                <th className="px-3 py-2 font-medium">Why</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((entry) => (
                <tr key={entry.id} className={cn("border-t border-border align-top", !entry.ok && "bg-destructive/5")}>
                  <td className="px-3 py-2 font-mono text-xs">{entry.id}</td>
                  <td className="max-w-md px-3 py-2 font-mono text-xs break-all">{entry.action}</td>
                  <td className="px-3 py-2"><DecisionBadge decision={entry.expect} /></td>
                  <td className="px-3 py-2"><DecisionBadge decision={entry.decision} /></td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {entry.ruleName ? <span className="font-medium text-foreground">{entry.ruleName}: </span> : null}
                    {entry.reason}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setShowAll((value) => !value)}>
        {showAll ? "Show only failures" : `Show all ${view.total} cases`}
      </button>
    </div>
  );
}

function RulePreview({ run }: { run: ClassifierRun }) {
  if (run.companyRules.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        You have no plain-English rules yet, so nothing is reviewed against them.{" "}
        <Link to="/company/settings/guardrails" className="underline">Add a rule in Guardrails</Link>.
      </p>
    );
  }
  const stopped = run.preview.filter((entry) => entry.decision !== "allow");
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        The same {run.preview.length} agent actions, judged against your {run.companyRules.length} rule(s). {stopped.length} would be stopped.
      </p>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Agent action</th>
              <th className="px-3 py-2 font-medium">Your rules say</th>
              <th className="px-3 py-2 font-medium">Why</th>
            </tr>
          </thead>
          <tbody>
            {run.preview.map((entry) => (
              <tr key={entry.id} className="border-t border-border align-top">
                <td className="max-w-md px-3 py-2 font-mono text-xs break-all">{entry.action}</td>
                <td className="px-3 py-2"><DecisionBadge decision={entry.decision} /></td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {entry.ruleName ? <span className="font-medium text-foreground">{entry.ruleName}: </span> : null}
                  {entry.decision === "allow" ? "" : entry.reason}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CohortColumn({ title, summary }: { title: string; summary: EvalCohortSummary | undefined }) {
  return (
    <div className="space-y-1 rounded-md border border-border px-3 py-2">
      <div className="text-sm font-medium">{title}</div>
      {!summary ? (
        <div className="text-xs text-muted-foreground">No agents</div>
      ) : (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Agents</dt><dd className="tabular-nums">{summary.agents}</dd>
          <dt className="text-muted-foreground">Runs</dt><dd className="tabular-nums">{summary.runs}</dd>
          <dt className="text-muted-foreground">Success rate</dt><dd className="tabular-nums">{percent(summary.successRate)}</dd>
          <dt className="text-muted-foreground">Cost per run</dt><dd className="tabular-nums">{dollars(summary.costCentsPerRun)}</dd>
          <dt className="text-muted-foreground">Tokens per run</dt><dd className="tabular-nums">{compactNumber(summary.avgTokensPerRun)}</dd>
          <dt className="text-muted-foreground">Total cost</dt><dd className="tabular-nums">{dollars(summary.costCents)}</dd>
        </dl>
      )}
    </div>
  );
}

function AgentCohorts({ companyId }: { companyId: string }) {
  const [thresholdDays, setThresholdDays] = useState(14);
  const cohortsQuery = useQuery({
    queryKey: queryKeys.evals.cohorts(companyId, thresholdDays),
    queryFn: () => evalsApi.agentCohorts(companyId, thresholdDays),
  });
  const data: EvalCohortComparison | undefined = cohortsQuery.data;
  const newer = data?.cohorts.find((entry) => entry.cohort === "new");
  const established = data?.cohorts.find((entry) => entry.cohort === "established");
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">New vs established agents</h2>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          New = created in the last
          <select
            className="rounded border border-border bg-background px-1.5 py-0.5 text-xs"
            value={thresholdDays}
            onChange={(event) => setThresholdDays(Number(event.target.value))}
          >
            {[7, 14, 30, 60].map((days) => <option key={days} value={days}>{days} days</option>)}
          </select>
        </label>
      </div>
      <p className="text-sm text-muted-foreground">From your real run and cost history: are newly added agents as reliable and as cheap per run as the ones that have been around?</p>
      {cohortsQuery.isLoading ? (
        <PageSkeleton variant="list" />
      ) : cohortsQuery.error ? (
        <div className="text-sm text-destructive">{errorMessage(cohortsQuery.error)}</div>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            <CohortColumn title={`New (≤ ${thresholdDays} days)`} summary={newer} />
            <CohortColumn title="Established" summary={established} />
          </div>
          {data ? (
            <p className="text-xs text-muted-foreground">
              Difference (new − established): success rate {data.delta.successRate === null ? "—" : `${(data.delta.successRate * 100).toFixed(1)} pts`}, cost per run{" "}
              {data.delta.costCentsPerRun === null ? "—" : dollars(data.delta.costCentsPerRun)}. {data.cohortDefinition}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

export function Evals() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [freshRun, setFreshRun] = useState<ClassifierRun | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Company Settings", href: "/company/settings" }, { label: "Evals" }]);
  }, [setBreadcrumbs]);

  const historyQuery = useQuery({
    queryKey: queryKeys.evals.results(selectedCompanyId ?? "", CLASSIFIER_SCENARIO_ID),
    queryFn: () => evalsApi.listResults(selectedCompanyId!, CLASSIFIER_SCENARIO_ID),
    enabled: Boolean(selectedCompanyId),
  });
  const history = useMemo(
    () => [...(historyQuery.data ?? [])].sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt)),
    [historyQuery.data],
  );

  const runMutation = useMutation({
    mutationFn: () => evalsApi.runClassifier(selectedCompanyId!),
    onSuccess: (run) => {
      setFreshRun(run);
      void queryClient.invalidateQueries({ queryKey: queryKeys.evals.results(selectedCompanyId ?? "", CLASSIFIER_SCENARIO_ID) });
    },
    onError: (error) => pushToast({ title: "Classifier eval failed", body: errorMessage(error), tone: "error" }),
  });

  if (!selectedCompanyId) return <EmptyState icon={FlaskConical} message="Select a company." />;

  const latestView = freshRun ? viewFromRun(freshRun) : history[0] ? viewFromStoredResult(history[0]) : null;

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Evals</h1>
        <p className="text-sm text-muted-foreground">
          How well the guardrails judge agent actions, and how new agents compare with established ones.
        </p>
      </div>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold">Guardrail classifier</h2>
            <p className="text-sm text-muted-foreground">
              Runs the classifier that reviews every agent action over {latestView?.total ?? 24} labelled agent actions — config changes, unapproved sub-issues,
              merges, reworded attempts, and normal work that must not be blocked. Takes about 30 seconds and a few thousand tokens.
            </p>
          </div>
          <Button size="sm" onClick={() => runMutation.mutate()} disabled={runMutation.isPending}>
            <Play className="mr-1.5 h-3.5 w-3.5" />
            {runMutation.isPending ? "Running…" : "Run now"}
          </Button>
        </div>
        {historyQuery.isLoading && !freshRun ? (
          <PageSkeleton variant="list" />
        ) : latestView ? (
          <ClassifierResults view={latestView} />
        ) : (
          <p className="text-sm text-muted-foreground">Not run yet.</p>
        )}
        {history.length > 1 ? (
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">Previous runs</div>
            <ul className="space-y-0.5 text-xs">
              {history.slice(0, 10).map((row) => (
                <li key={row.id} className="flex gap-3 tabular-nums">
                  <span className="w-28 text-muted-foreground">{relativeTime(row.evaluatedAt)}</span>
                  <span className={row.status === "passed" ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}>{row.status}</span>
                  <span>{percent(row.score)}</span>
                  <span className="text-muted-foreground">{row.bundleId.replace(/^classifier\./, "")}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {freshRun ? (
        <section className="space-y-3">
          <h2 className="text-base font-semibold">Your rules on the same actions</h2>
          <RulePreview run={freshRun} />
        </section>
      ) : null}

      <AgentCohorts companyId={selectedCompanyId} />

      <section className="space-y-1">
        <h2 className="text-base font-semibold">Live agent scenarios</h2>
        <p className="text-sm text-muted-foreground">
          Real agent sessions (30k–270k tokens each) are not run from here. Run them on purpose with{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">pnpm evals:run -- --live</code>.
        </p>
      </section>
    </div>
  );
}
