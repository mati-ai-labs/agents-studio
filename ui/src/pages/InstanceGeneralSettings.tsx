import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PatchInstanceGeneralSettings, BackupRetentionPolicy } from "@paperclipai/shared";
import {
  DAILY_RETENTION_PRESETS,
  WEEKLY_RETENTION_PRESETS,
  MONTHLY_RETENTION_PRESETS,
  DEFAULT_BACKUP_RETENTION,
  DEFAULT_MAX_CONCURRENT_AGENT_RUNS,
  MIN_MAX_CONCURRENT_AGENT_RUNS,
  MAX_MAX_CONCURRENT_AGENT_RUNS,
  DEFAULT_PROVIDER_QUOTA_RESERVE_PERCENT,
  MAX_PROVIDER_QUOTA_RESERVE_PERCENT,
} from "@paperclipai/shared";
import { LogOut, SlidersHorizontal } from "lucide-react";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { instanceSettingsApi, type InstanceRunSlotStatus } from "@/api/instanceSettings";
import { ModeBadge } from "@/components/access/ModeBadge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { cn } from "../lib/utils";

const FEEDBACK_TERMS_URL = import.meta.env.VITE_FEEDBACK_TERMS_URL?.trim() || "https://paperclip.ing/tos";

export function InstanceGeneralSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const signOutMutation = useMutation({
    mutationFn: () => authApi.signOut(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to sign out.");
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings" },
      { label: "General" },
    ]);
  }, [setBreadcrumbs]);

  const generalQuery = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  });
  const runSlotsQuery = useQuery({
    queryKey: queryKeys.instance.runSlots,
    queryFn: () => instanceSettingsApi.getRunSlots(),
    refetchInterval: 10_000,
  });
  const savedRunCap = generalQuery.data?.maxConcurrentAgentRuns ?? DEFAULT_MAX_CONCURRENT_AGENT_RUNS;
  const [runCapDraft, setRunCapDraft] = useState<string>("");
  useEffect(() => {
    setRunCapDraft(String(savedRunCap));
  }, [savedRunCap]);
  const savedReserve =
    generalQuery.data?.providerQuotaReservePercent ?? DEFAULT_PROVIDER_QUOTA_RESERVE_PERCENT;
  const [reserveDraft, setReserveDraft] = useState<string>("");
  useEffect(() => {
    setReserveDraft(String(savedReserve));
  }, [savedReserve]);
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });

  const updateGeneralMutation = useMutation({
    mutationFn: instanceSettingsApi.updateGeneral,
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings });
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.runSlots });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to update general settings.");
    },
  });

  if (generalQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading general settings...</div>;
  }

  if (generalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {generalQuery.error instanceof Error
          ? generalQuery.error.message
          : "Failed to load general settings."}
      </div>
    );
  }

  const censorUsernameInLogs = generalQuery.data?.censorUsernameInLogs === true;
  const keyboardShortcuts = generalQuery.data?.keyboardShortcuts === true;
  const feedbackDataSharingPreference = generalQuery.data?.feedbackDataSharingPreference ?? "prompt";
  const backupRetention: BackupRetentionPolicy = generalQuery.data?.backupRetention ?? DEFAULT_BACKUP_RETENTION;
  const parsedRunCap = Number(runCapDraft);
  const runCapValid =
    Number.isInteger(parsedRunCap) &&
    parsedRunCap >= MIN_MAX_CONCURRENT_AGENT_RUNS &&
    parsedRunCap <= MAX_MAX_CONCURRENT_AGENT_RUNS;
  const runCapDirty = runCapValid && parsedRunCap !== savedRunCap;
  const runSlots = runSlotsQuery.data;
  const quota = runSlots?.providerQuota;
  const quotaGateEnabled = generalQuery.data?.providerQuotaGateEnabled !== false;
  const parsedReserve = Number(reserveDraft);
  const reserveValid =
    Number.isInteger(parsedReserve) && parsedReserve >= 0 && parsedReserve <= MAX_PROVIDER_QUOTA_RESERVE_PERCENT;
  const reserveDirty = reserveValid && parsedReserve !== savedReserve;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">General</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Configure instance-wide preferences including log display, keyboard shortcuts, backup
          retention, and data sharing.
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Deployment and auth</h2>
            <ModeBadge
              deploymentMode={healthQuery.data?.deploymentMode}
              deploymentExposure={healthQuery.data?.deploymentExposure}
            />
          </div>
          <div className="text-sm text-muted-foreground">
            {healthQuery.data?.deploymentMode === "local_trusted"
              ? "Local trusted mode is optimized for a local operator. Browser requests run as local board context and no sign-in is required."
              : healthQuery.data?.deploymentExposure === "public"
                ? "Authenticated public mode requires sign-in for board access and is intended for public URLs."
                : "Authenticated private mode requires sign-in and is intended for LAN, VPN, or other private-network deployments."}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <StatusBox
              label="Auth readiness"
              value={healthQuery.data?.authReady ? "Ready" : "Not ready"}
            />
            <StatusBox
              label="Bootstrap status"
              value={healthQuery.data?.bootstrapStatus === "bootstrap_pending" ? "Setup required" : "Ready"}
            />
            <StatusBox
              label="Bootstrap invite"
              value={healthQuery.data?.bootstrapInviteActive ? "Active" : "None"}
            />
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Max parallel agent runs</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              The most agent runs that can execute at the same time across all companies and agents. Runs over
              the limit wait in the queue and start as running ones finish. Each agent's own concurrency setting
              still applies inside this limit.
            </p>
          </div>
          <form
            className="flex flex-wrap items-center gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!runCapDirty) return;
              updateGeneralMutation.mutate({ maxConcurrentAgentRuns: parsedRunCap });
            }}
          >
            <Input
              type="number"
              inputMode="numeric"
              min={MIN_MAX_CONCURRENT_AGENT_RUNS}
              max={MAX_MAX_CONCURRENT_AGENT_RUNS}
              step={1}
              value={runCapDraft}
              onChange={(event) => setRunCapDraft(event.target.value)}
              aria-label="Max parallel agent runs"
              aria-invalid={!runCapValid}
              className="w-24 tabular-nums"
            />
            <Button type="submit" size="sm" disabled={!runCapDirty || updateGeneralMutation.isPending}>
              Save
            </Button>
            {!runCapValid && (
              <span className="text-xs text-destructive">
                Enter a whole number from {MIN_MAX_CONCURRENT_AGENT_RUNS} to {MAX_MAX_CONCURRENT_AGENT_RUNS}.
              </span>
            )}
          </form>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatusBox label="Running now" value={runSlots ? `${runSlots.running} of ${runSlots.maxConcurrentAgentRuns}` : "-"} />
            <StatusBox label="Free slots" value={runSlots ? String(runSlots.available) : "-"} />
            <StatusBox label="Waiting in queue" value={runSlots ? String(runSlots.queued) : "-"} />
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1.5">
              <h2 className="text-sm font-semibold">Hold runs when the model plan quota is used up</h2>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Before starting a Claude Code agent run, check the provider plan's remaining quota (MiniMax Token
                Plan: 5-hour and weekly windows). If a window is at or below the reserve, runs stay queued and start
                after it resets, instead of failing with "usage limit reached". Codex agents are not affected. If the
                quota check fails, runs start as normal.
              </p>
            </div>
            <ToggleSwitch
              checked={quotaGateEnabled}
              onCheckedChange={() => updateGeneralMutation.mutate({ providerQuotaGateEnabled: !quotaGateEnabled })}
              disabled={updateGeneralMutation.isPending}
              aria-label="Toggle holding runs when the plan quota is used up"
            />
          </div>
          <form
            className="flex flex-wrap items-center gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!reserveDirty) return;
              updateGeneralMutation.mutate({ providerQuotaReservePercent: parsedReserve });
            }}
          >
            <label className="text-sm text-muted-foreground" htmlFor="provider-quota-reserve">
              Hold when remaining is at or below
            </label>
            <Input
              id="provider-quota-reserve"
              type="number"
              inputMode="numeric"
              min={0}
              max={MAX_PROVIDER_QUOTA_RESERVE_PERCENT}
              step={1}
              value={reserveDraft}
              onChange={(event) => setReserveDraft(event.target.value)}
              aria-invalid={!reserveValid}
              className="w-20 tabular-nums"
            />
            <span className="text-sm text-muted-foreground">%</span>
            <Button type="submit" size="sm" disabled={!reserveDirty || updateGeneralMutation.isPending}>
              Save
            </Button>
            {!reserveValid && (
              <span className="text-xs text-destructive">
                Enter a whole number from 0 to {MAX_PROVIDER_QUOTA_RESERVE_PERCENT}.
              </span>
            )}
          </form>
          <ProviderQuotaPanel quota={quota} />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Censor username in logs</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Hide the username segment in home-directory paths and similar operator-visible log output. Standalone
              username mentions outside of paths are not yet masked in the live transcript view. This is off by
              default.
            </p>
          </div>
          <ToggleSwitch
            checked={censorUsernameInLogs}
            onCheckedChange={() => updateGeneralMutation.mutate({ censorUsernameInLogs: !censorUsernameInLogs })}
            disabled={updateGeneralMutation.isPending}
            aria-label="Toggle username log censoring"
          />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Keyboard shortcuts</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Enable app keyboard shortcuts, including inbox navigation and global shortcuts like creating issues or
              toggling panels. This is off by default.
            </p>
          </div>
          <ToggleSwitch
            checked={keyboardShortcuts}
            onCheckedChange={() => updateGeneralMutation.mutate({ keyboardShortcuts: !keyboardShortcuts })}
            disabled={updateGeneralMutation.isPending}
            aria-label="Toggle keyboard shortcuts"
          />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-5">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Backup retention</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Configure how long automatic database backups are retained. Backups run roughly
              every hour and are compressed with gzip. Within the daily window all backups are
              kept; beyond that, one backup per week and one per month are preserved.
            </p>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Daily</h3>
            <div className="flex flex-wrap gap-2">
              {DAILY_RETENTION_PRESETS.map((days) => {
                const active = backupRetention.dailyDays === days;
                return (
                  <button
                    key={days}
                    type="button"
                    disabled={updateGeneralMutation.isPending}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      active
                        ? "border-foreground bg-accent text-foreground"
                        : "border-border bg-background hover:bg-accent/50",
                    )}
                    onClick={() =>
                      updateGeneralMutation.mutate({
                        backupRetention: { ...backupRetention, dailyDays: days },
                      })
                    }
                  >
                    <div className="text-sm font-medium">{days} days</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Weekly</h3>
            <div className="flex flex-wrap gap-2">
              {WEEKLY_RETENTION_PRESETS.map((weeks) => {
                const active = backupRetention.weeklyWeeks === weeks;
                const label = weeks === 1 ? "1 week" : `${weeks} weeks`;
                return (
                  <button
                    key={weeks}
                    type="button"
                    disabled={updateGeneralMutation.isPending}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      active
                        ? "border-foreground bg-accent text-foreground"
                        : "border-border bg-background hover:bg-accent/50",
                    )}
                    onClick={() =>
                      updateGeneralMutation.mutate({
                        backupRetention: { ...backupRetention, weeklyWeeks: weeks },
                      })
                    }
                  >
                    <div className="text-sm font-medium">{label}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Monthly</h3>
            <div className="flex flex-wrap gap-2">
              {MONTHLY_RETENTION_PRESETS.map((months) => {
                const active = backupRetention.monthlyMonths === months;
                const label = months === 1 ? "1 month" : `${months} months`;
                return (
                  <button
                    key={months}
                    type="button"
                    disabled={updateGeneralMutation.isPending}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      active
                        ? "border-foreground bg-accent text-foreground"
                        : "border-border bg-background hover:bg-accent/50",
                    )}
                    onClick={() =>
                      updateGeneralMutation.mutate({
                        backupRetention: { ...backupRetention, monthlyMonths: months },
                      })
                    }
                  >
                    <div className="text-sm font-medium">{label}</div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">AI feedback sharing</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Control whether thumbs up and thumbs down votes can send the voted AI output to
              Agent Studio. Votes are always saved locally.
            </p>
            {FEEDBACK_TERMS_URL ? (
              <a
                href={FEEDBACK_TERMS_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                Read our terms of service
              </a>
            ) : null}
          </div>
          {feedbackDataSharingPreference === "prompt" ? (
            <div className="rounded-lg border border-border/70 bg-accent/20 px-3 py-2 text-sm text-muted-foreground">
              No default is saved yet. The next thumbs up or thumbs down choice will ask once and
              then save the answer here.
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {[
              {
                value: "allowed",
                label: "Always allow",
                description: "Share voted AI outputs automatically.",
              },
              {
                value: "not_allowed",
                label: "Don't allow",
                description: "Keep voted AI outputs local only.",
              },
            ].map((option) => {
              const active = feedbackDataSharingPreference === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={updateGeneralMutation.isPending}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                    active
                      ? "border-foreground bg-accent text-foreground"
                      : "border-border bg-background hover:bg-accent/50",
                  )}
                  onClick={() =>
                    updateGeneralMutation.mutate({
                      feedbackDataSharingPreference: option.value as
                        | "allowed"
                        | "not_allowed",
                    })
                  }
                >
                  <div className="text-sm font-medium">{option.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {option.description}
                  </div>
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            To retest the first-use prompt in local dev, remove the{" "}
            <code>feedbackDataSharingPreference</code> key from the{" "}
            <code>instance_settings.general</code> JSON row for this instance, or set it back to{" "}
            <code>"prompt"</code>. Unset and <code>"prompt"</code> both mean no default has been
            chosen yet.
          </p>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Sign out</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Sign out of this Agent Studio instance. You will be redirected to the login page.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={signOutMutation.isPending}
            onClick={() => signOutMutation.mutate()}
          >
            <LogOut className="size-4" />
            {signOutMutation.isPending ? "Signing out..." : "Sign out"}
          </Button>
        </div>
      </section>
    </div>
  );
}

function formatResetTime(iso: string | null) {
  if (!iso) return "unknown";
  const date = new Date(iso);
  const minutes = Math.max(0, Math.round((date.getTime() - Date.now()) / 60_000));
  const inText = minutes >= 120 ? `${Math.round(minutes / 60)}h` : `${minutes}m`;
  return `${date.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })} (in ${inText})`;
}

function ProviderQuotaPanel({ quota }: { quota: InstanceRunSlotStatus["providerQuota"] | undefined }) {
  if (!quota) return <div className="text-sm text-muted-foreground">Checking plan quota...</div>;
  if (quota.provider === "unconfigured") {
    return <div className="text-sm text-muted-foreground">No ANTHROPIC_BASE_URL / token configured for Claude Code, so there is no plan quota to check.</div>;
  }
  if (quota.provider === "unsupported") {
    return <div className="text-sm text-muted-foreground">Claude Code points at a provider without a supported quota API. Runs are not held.</div>;
  }
  return (
    <div className="space-y-3">
      <div
        className={cn(
          "rounded-md border px-3 py-2 text-sm",
          quota.error
            ? "border-destructive/40 bg-destructive/5 text-destructive"
            : quota.holding
              ? "border-amber-500/40 bg-amber-500/5"
              : "border-border bg-background",
        )}
      >
        {quota.error
          ? `MiniMax quota check failed (${quota.error}). Runs are not being held.`
          : quota.holding
            ? `Holding new Claude Code runs: ${quota.reason}. Resumes ${formatResetTime(quota.resumeAt)}.`
            : !quota.enabled
              ? "Hold is off. Runs start even when the quota is used up."
              : "Quota available. Runs start as normal."}
      </div>
      {quota.windows.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {quota.windows.map((window) => (
            <StatusBox
              key={window.key}
              label={`MiniMax ${window.label}`}
              value={`${window.remainingPercent ?? "?"}% left${window.providerExhausted ? " (used up)" : ""} · resets ${formatResetTime(window.resetsAt)}`}
            />
          ))}
        </div>
      )}
      <div className="text-xs text-muted-foreground">
        Checked {new Date(quota.checkedAt).toLocaleTimeString()} · refreshed every minute
      </div>
    </div>
  );
}

function StatusBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-background px-3 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-2 text-sm font-medium">{value}</div>
    </div>
  );
}
