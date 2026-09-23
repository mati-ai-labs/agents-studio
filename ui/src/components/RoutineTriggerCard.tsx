import { useEffect, useMemo, useState } from "react";
import { Clock3, Copy, Link2, RefreshCw, Save, Trash2, Webhook, Zap } from "lucide-react";
import type { RoutineTrigger, RoutineTriggerSecretMaterial, RoutineVariable } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScheduleEditor } from "./ScheduleEditor";
import { buildRoutineTriggerPatch } from "../lib/routine-trigger-patch";
import { describeCron } from "../lib/cron-readable";
import { buildRoutineAgentConnectionCommand } from "../lib/routine-agent-connection";

const signingModes = ["bearer", "hmac_sha256", "github_hmac", "none"];
const SIGNING_MODES_WITHOUT_REPLAY_WINDOW = new Set(["github_hmac", "none"]);

function getLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

/**
 * Single trigger card with its own field-edit + save state (§3.2). Extracted
 * from the previous inline `TriggerEditor` in `RoutineDetail.tsx` — same logic.
 */
export function RoutineTriggerCard({
  trigger,
  variables,
  onSave,
  onRotate,
  onConnect,
  onDelete,
  disabled,
}: {
  trigger: RoutineTrigger;
  variables: RoutineVariable[];
  onSave: (id: string, patch: Record<string, unknown>) => void;
  onRotate: (id: string) => void;
  onConnect: (id: string) => Promise<{ secretMaterial: RoutineTriggerSecretMaterial }>;
  onDelete: (id: string) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState({
    label: trigger.label ?? "",
    cronExpression: trigger.cronExpression ?? "",
    signingMode: trigger.signingMode ?? "bearer",
    replayWindowSec: String(trigger.replayWindowSec ?? 300),
  });
  const [connection, setConnection] = useState<RoutineTriggerSecretMaterial | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);

  useEffect(() => {
    setDraft({
      label: trigger.label ?? "",
      cronExpression: trigger.cronExpression ?? "",
      signingMode: trigger.signingMode ?? "bearer",
      replayWindowSec: String(trigger.replayWindowSec ?? 300),
    });
  }, [trigger]);

  const KindIcon =
    trigger.kind === "schedule" ? Clock3 : trigger.kind === "webhook" ? Webhook : Zap;
  const humanCron = trigger.kind === "schedule" ? describeCron(draft.cronExpression) : null;
  const lastResultOk =
    trigger.lastResult != null &&
    /succeed|success|ok|200|delivered/i.test(String(trigger.lastResult));
  const connectionCommand = useMemo(() => {
    if (!connection) return "";
    return buildRoutineAgentConnectionCommand({ connection, variables });
  }, [connection, variables]);

  return (
    <form
      aria-label={`Trigger: ${trigger.label ?? trigger.kind}`}
      className="space-y-4 rounded-lg border border-border p-4"
      onSubmit={(event) => event.preventDefault()}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <KindIcon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{trigger.label ?? trigger.kind}</span>
          </div>
          {humanCron ? (
            <p id={`cron-readable-${trigger.id}`} className="text-xs text-muted-foreground">
              {humanCron}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {trigger.lastResult ? (
            <Badge variant={lastResultOk ? "secondary" : "destructive"}>
              {String(trigger.lastResult)}
            </Badge>
          ) : null}
          <span className="text-xs text-muted-foreground">
            {trigger.kind === "schedule" && trigger.nextRunAt
              ? `Next: ${new Date(trigger.nextRunAt).toLocaleString()}`
              : trigger.kind === "webhook"
                ? "Webhook"
                : "API"}
          </span>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">Label</Label>
          <Input
            value={draft.label}
            disabled={disabled}
            onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
          />
        </div>
        {trigger.kind === "schedule" && (
          <div className="space-y-1.5 md:col-span-2">
            <Label className="text-xs">Schedule</Label>
            <ScheduleEditor
              value={draft.cronExpression}
              onChange={(cronExpression) =>
                setDraft((current) => ({ ...current, cronExpression }))
              }
            />
          </div>
        )}
        {trigger.kind === "webhook" && (
          <>
            <div className="space-y-1.5">
              <Label className="text-xs">Signing mode</Label>
              <Select
                value={draft.signingMode}
                onValueChange={(signingMode) =>
                  setDraft((current) => ({ ...current, signingMode }))
                }
                disabled={disabled}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {signingModes.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {mode}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {!SIGNING_MODES_WITHOUT_REPLAY_WINDOW.has(draft.signingMode) && (
              <div className="space-y-1.5">
                <Label className="text-xs">Replay window (seconds)</Label>
                <Input
                  value={draft.replayWindowSec}
                  disabled={disabled}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, replayWindowSec: event.target.value }))
                  }
                />
              </div>
            )}
          </>
        )}
      </div>

      {!disabled && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="mr-auto text-muted-foreground hover:text-destructive"
            onClick={() => onDelete(trigger.id)}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            Delete
          </Button>
          {trigger.kind === "webhook" && (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={isConnecting}
                onClick={async () => {
                  setIsConnecting(true);
                  try {
                    const result = await onConnect(trigger.id);
                    setConnection(result.secretMaterial);
                  } finally {
                    setIsConnecting(false);
                  }
                }}
              >
                <Link2 className="mr-1.5 h-3.5 w-3.5" />
                {isConnecting ? "Preparing…" : "Connect to your agent"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => onRotate(trigger.id)}>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                Rotate secret
              </Button>
            </>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              onSave(trigger.id, buildRoutineTriggerPatch(trigger, draft, getLocalTimezone()))
            }
          >
            <Save className="mr-1.5 h-3.5 w-3.5" />
            Save trigger
          </Button>
        </div>
      )}
      {connection ? (
        <div className="space-y-3 rounded-md border border-blue-500/30 bg-blue-500/5 p-3 text-sm">
          <div>
            <p className="font-medium">Agent connection instructions</p>
            <p className="text-xs text-muted-foreground">
              A new bearer token was generated. Copy this into the calling agent now; Paperclip will not show it again.
              The command preserves the original source issue across downstream routines; completed results and artifacts return there automatically.
            </p>
          </div>
          <pre className="max-h-48 overflow-auto rounded bg-background p-3 text-xs leading-relaxed whitespace-pre-wrap">{connectionCommand}</pre>
          <Button variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(connectionCommand)}>
            <Copy className="mr-1.5 h-3.5 w-3.5" />
            Copy invocation
          </Button>
        </div>
      ) : null}
    </form>
  );
}
