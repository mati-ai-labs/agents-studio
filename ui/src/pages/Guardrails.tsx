import { useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GUARDRAIL_MATCHER_FIELDS,
  GUARDRAIL_POLICY_ACTIONS,
  GUARDRAIL_POLICY_KINDS,
  GUARDRAIL_POLICY_SCOPE_TYPES,
  GUARDRAIL_POLICY_SEVERITIES,
  GUARDRAIL_POLICY_STAGES,
  createGuardrailPolicySchema,
  type CreateGuardrailPolicy,
  type GuardrailMatcher,
  type GuardrailPolicyAction,
  type GuardrailPolicyKind,
  type GuardrailPolicyScopeType,
  type GuardrailPolicySeverity,
  type GuardrailPolicyStage,
} from "@paperclipai/shared";
import {
  guardrailsApi,
  summariseFiresByPolicy,
  type GuardrailFireSummary,
  type GuardrailPolicy,
  type GuardrailPolicyBodyCandidate,
  type GuardrailSimulationResult,
  type GuardrailViolation,
} from "../api/guardrails";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { goalsApi } from "../api/goals";
import { ApiError } from "../api/client";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { InlineEntitySelector } from "../components/InlineEntitySelector";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ShieldAlert, ShieldCheck, Trash2, Plus, Play, Pencil, Ban } from "lucide-react";

const STAGE_LABELS: Record<GuardrailPolicyStage, string> = {
  input: "Input",
  output: "Output",
  action: "Action",
};

const KIND_LABELS: Record<GuardrailPolicyKind, string> = {
  pii: "PII",
  secret: "Secret",
  restricted_action: "Restricted action",
  regex: "Regex",
  allowlist: "Allowlist",
};

const ACTION_LABELS: Record<GuardrailPolicyAction, string> = {
  allow: "Allow",
  redact: "Redact",
  block: "Block",
  require_approval: "Require approval",
};

const SEVERITY_LABELS: Record<GuardrailPolicySeverity, string> = {
  info: "Info",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

const SCOPE_LABELS: Record<GuardrailPolicyScopeType, string> = {
  company: "Whole company",
  agent: "One agent",
  project: "One project",
  goal: "One goal",
};

const MATCHER_FIELD_LABELS: Record<string, string> = {
  any: "Any field",
  comment: "Comments",
  description: "Issue descriptions",
  title: "Issue titles",
  document_body: "Document bodies",
  tool_result: "Tool results",
  tool_args: "Tool arguments",
  tool_name: "Tool names",
};

/**
 * The credential families a `secret` policy can select. These are the kinds
 * the studio's own redaction recognises, so a policy cannot claim to catch a
 * secret the rest of the product misses.
 */
const SECRET_TYPE_OPTIONS = [
  "pem_block",
  "secret_assignment",
  "bearer_token",
  "github_token",
  "provider_api_key",
  "jwt",
  "dsn",
] as const;

/** The personal-data families a `pii` policy can select. */
const PII_TYPE_OPTIONS = ["email", "phone"] as const;

const ALL_SCOPE_OPTIONS = "__all__";

const ACTION_TONES: Record<GuardrailPolicyAction, string> = {
  allow: "border-border bg-muted/40 text-muted-foreground",
  redact: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  block: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  require_approval: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
};

const SEVERITY_TONES: Record<GuardrailPolicySeverity, string> = {
  info: "text-muted-foreground",
  medium: "text-sky-700 dark:text-sky-300",
  high: "text-amber-700 dark:text-amber-300",
  critical: "text-red-700 dark:text-red-300",
};

export type PolicyDraft = {
  name: string;
  description: string;
  scopeType: GuardrailPolicyScopeType;
  scopeId: string;
  stage: GuardrailPolicyStage;
  kind: GuardrailPolicyKind;
  action: GuardrailPolicyAction;
  severity: GuardrailPolicySeverity;
  enabled: boolean;
  /** `regex` patterns, one per line. */
  patterns: string;
  /** `allowlist` values, one per line. */
  values: string;
  /** `pii` family names. */
  piiTypes: string[];
  /** `secret` family names. */
  secretTypes: string[];
  /** `restricted_action` tool names, one per line. */
  toolNames: string;
  /** `restricted_action` connector types, one per line. */
  connectorTypes: string;
  /** `restricted_action` argument patterns, one `path=pattern` per line. */
  argumentPatterns: string;
  /** Matcher fields the policy applies to. Empty means every field. */
  fields: string[];
};

function emptyDraft(): PolicyDraft {
  return {
    name: "",
    description: "",
    scopeType: "company",
    scopeId: "",
    stage: "input",
    kind: "pii",
    action: "redact",
    severity: "medium",
    enabled: true,
    patterns: "",
    values: "",
    piiTypes: [],
    secretTypes: [],
    toolNames: "",
    connectorTypes: "",
    argumentPatterns: "",
    fields: [],
  };
}

function splitLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Splits an `argumentPatterns` line into the `{ path, pattern }` pair the
 * matcher expects. A line without a `=` is ignored, since there is no way to
 * tell the path from the pattern.
 */
function splitArgumentPatterns(value: string): Array<{ path: string; pattern: string }> {
  const entries: Array<{ path: string; pattern: string }> = [];
  for (const line of splitLines(value)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const path = line.slice(0, separator).trim();
    const pattern = line.slice(separator + 1).trim();
    if (!path || !pattern) continue;
    entries.push({ path, pattern });
  }
  return entries;
}

function draftFromPolicy(policy: GuardrailPolicy): PolicyDraft {
  const matcher = (policy.matcher ?? {}) as Record<string, unknown>;
  const patterns = Array.isArray(matcher.patterns) ? (matcher.patterns as string[]) : [];
  const values = Array.isArray(matcher.values) ? (matcher.values as string[]) : [];
  const piiTypes = Array.isArray(matcher.piiTypes) ? (matcher.piiTypes as string[]) : [];
  const secretTypes = Array.isArray(matcher.secretTypes) ? (matcher.secretTypes as string[]) : [];
  const toolNames = Array.isArray(matcher.toolNames) ? (matcher.toolNames as string[]) : [];
  const connectorTypes = Array.isArray(matcher.connectorTypes)
    ? (matcher.connectorTypes as string[])
    : [];
  const argumentPatterns = Array.isArray(matcher.argumentPatterns)
    ? (matcher.argumentPatterns as Array<{ path?: string; pattern?: string }>)
    : [];
  const fields = Array.isArray(matcher.fields) ? (matcher.fields as string[]) : [];

  return {
    name: policy.name,
    description: policy.description ?? "",
    scopeType: policy.scopeType,
    scopeId: policy.scopeId ?? "",
    stage: policy.stage,
    kind: policy.kind,
    action: policy.action,
    severity: policy.severity,
    enabled: policy.enabled,
    patterns: patterns.join("\n"),
    values: values.join("\n"),
    piiTypes,
    secretTypes,
    toolNames: toolNames.join("\n"),
    connectorTypes: connectorTypes.join("\n"),
    argumentPatterns: argumentPatterns
      .map((entry) => `${entry.path ?? ""}=${entry.pattern ?? ""}`)
      .join("\n"),
    fields,
  };
}

/**
 * Turn the editor's flat draft into the policy body the API takes. The
 * matcher is built per kind so no irrelevant keys are sent, and it carries
 * its own `kind` so it stays self-describing when read back.
 */
export function draftToPolicyPayload(draft: PolicyDraft): CreateGuardrailPolicy {
  const base = {
    name: draft.name.trim(),
    description: draft.description.trim() ? draft.description.trim() : null,
    scopeType: draft.scopeType,
    scopeId: draft.scopeType === "company" ? null : draft.scopeId || null,
    stage: draft.stage,
    kind: draft.kind,
    action: draft.action,
    severity: draft.severity,
    enabled: draft.enabled,
  };

  if (draft.kind === "allowlist") {
    return {
      ...base,
      matcher: {
        kind: "allowlist",
        values: splitLines(draft.values),
        ...(draft.fields.length > 0 ? { fields: draft.fields } : {}),
      },
    } as CreateGuardrailPolicy;
  }

  if (draft.kind === "restricted_action") {
    return {
      ...base,
      matcher: {
        kind: "restricted_action",
        ...(splitLines(draft.toolNames).length > 0
          ? { toolNames: splitLines(draft.toolNames) }
          : {}),
        ...(splitLines(draft.connectorTypes).length > 0
          ? { connectorTypes: splitLines(draft.connectorTypes) }
          : {}),
        ...(splitArgumentPatterns(draft.argumentPatterns).length > 0
          ? { argumentPatterns: splitArgumentPatterns(draft.argumentPatterns) }
          : {}),
      },
    } as CreateGuardrailPolicy;
  }

  if (draft.kind === "pii") {
    return {
      ...base,
      matcher: {
        kind: "pii",
        ...(draft.piiTypes.length > 0 ? { piiTypes: draft.piiTypes } : {}),
        ...(draft.fields.length > 0 ? { fields: draft.fields } : {}),
      },
    } as CreateGuardrailPolicy;
  }

  if (draft.kind === "secret") {
    return {
      ...base,
      matcher: {
        kind: "secret",
        ...(draft.secretTypes.length > 0 ? { secretTypes: draft.secretTypes } : {}),
        ...(draft.fields.length > 0 ? { fields: draft.fields } : {}),
      },
    } as CreateGuardrailPolicy;
  }

  return {
    ...base,
    matcher: {
      kind: "regex",
      patterns: splitLines(draft.patterns),
      ...(draft.fields.length > 0 ? { fields: draft.fields } : {}),
    },
  } as CreateGuardrailPolicy;
}

/**
 * Pull field-level errors out of an API failure. The studio's error handler
 * returns zod issues as `details` for a 400, so a bad policy comes back with
 * one message per field rather than a single opaque string.
 */
export function extractApiFieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {};
  const body = error.body as { details?: unknown } | null;
  const details = body?.details;

  if (Array.isArray(details)) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of details) {
      if (!issue || typeof issue !== "object") continue;
      const record = issue as { path?: unknown; message?: unknown };
      const path = Array.isArray(record.path)
        ? record.path.map((segment) => String(segment)).join(".")
        : "";
      const message = typeof record.message === "string" ? record.message : null;
      if (!message) continue;
      if (!path || fieldErrors[path]) continue;
      fieldErrors[path] = message;
    }
    return fieldErrors;
  }

  if (details && typeof details === "object") {
    const fieldErrors: Record<string, string> = {};
    for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
      if (typeof value === "string") fieldErrors[key] = value;
      else if (Array.isArray(value) && typeof value[0] === "string") {
        fieldErrors[key] = value[0];
      }
    }
    return fieldErrors;
  }

  return {};
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-1 text-xs text-destructive">
      {message}
    </p>
  );
}

/**
 * Validates a draft against the shared schema the server validates against,
 * and turns the zod issues into the dotted-path errors the editor renders.
 */
export function validateDraft(draft: PolicyDraft): {
  fieldErrors: Record<string, string>;
  payload: CreateGuardrailPolicy | null;
} {
  const payload = draftToPolicyPayload(draft);
  const parsed = createGuardrailPolicySchema.safeParse(payload);
  if (parsed.success) return { fieldErrors: {}, payload: parsed.data };

  const fieldErrors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const path = issue.path.map((segment) => String(segment)).join(".");
    if (!path || fieldErrors[path]) continue;
    fieldErrors[path] = issue.message;
  }
  return { fieldErrors, payload: null };
}

/**
 * Builds the candidate policy the simulate endpoint evaluates alongside the
 * saved ones, so an author can see what their unsaved draft would do.
 *
 * The draft is validated first: a draft the shared schema rejects would be
 * rejected by the endpoint too, and the author should fix the form rather
 * than read a validation error from the simulator.
 */
export function draftToSimulationCandidate(
  draft: PolicyDraft,
): GuardrailPolicyBodyCandidate | null {
  const { payload } = validateDraft(draft);
  if (!payload) return null;
  return {
    scopeType: payload.scopeType,
    scopeId: payload.scopeId ?? null,
    stage: payload.stage,
    name: payload.name,
    description: payload.description ?? null,
    kind: payload.kind,
    matcher: payload.matcher ?? null,
    action: payload.action,
    severity: payload.severity,
    enabled: payload.enabled ?? true,
  };
}

function ScopeTargetSelector({
  draft,
  fieldError,
  onChange,
}: {
  draft: PolicyDraft;
  fieldError?: string;
  onChange: (scopeType: GuardrailPolicyScopeType, scopeId: string) => void;
}) {
  const { selectedCompanyId } = useCompany();

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && draft.scopeType === "agent",
  });
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId ?? ""),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && draft.scopeType === "project",
  });
  const goalsQuery = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId ?? ""),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && draft.scopeType === "goal",
  });

  const options = useMemo(() => {
    if (draft.scopeType === "agent") {
      return (agentsQuery.data ?? []).map((agent) => ({
        id: agent.id,
        label: agent.name,
      }));
    }
    if (draft.scopeType === "project") {
      return (projectsQuery.data ?? []).map((project) => ({
        id: project.id,
        label: project.name,
      }));
    }
    if (draft.scopeType === "goal") {
      return (goalsQuery.data ?? []).map((goal) => ({
        id: goal.id,
        label: goal.title,
      }));
    }
    return [];
  }, [agentsQuery.data, draft.scopeType, goalsQuery.data, projectsQuery.data]);

  const placeholder =
    draft.scopeType === "agent"
      ? "Choose an agent"
      : draft.scopeType === "project"
        ? "Choose a project"
        : "Choose a goal";

  return (
    <div>
      <InlineEntitySelector
        value={draft.scopeId}
        options={options}
        placeholder={placeholder}
        noneLabel="Select…"
        searchPlaceholder="Search…"
        emptyMessage="Nothing to choose from yet."
        onChange={(id) => onChange(draft.scopeType, id)}
      />
      <FieldError message={fieldError} />
    </div>
  );
}

export function GuardrailPolicyEditor({
  draft,
  fieldErrors,
  formError,
  isPending,
  submitLabel,
  onChange,
  onSubmit,
  onCancel,
}: {
  draft: PolicyDraft;
  fieldErrors: Record<string, string>;
  formError: string | null;
  isPending: boolean;
  submitLabel: string;
  onChange: (next: PolicyDraft) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const set = <K extends keyof PolicyDraft>(key: K, value: PolicyDraft[K]) => {
    onChange({ ...draft, [key]: value });
  };

  const toggleField = (field: string) => {
    const next = draft.fields.includes(field)
      ? draft.fields.filter((entry) => entry !== field)
      : [...draft.fields, field];
    set("fields", next);
  };

  const toggleType = (key: "piiTypes" | "secretTypes", value: string) => {
    const current = draft[key];
    const next = current.includes(value)
      ? current.filter((entry) => entry !== value)
      : [...current, value];
    set(key, next);
  };

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      noValidate
    >
      {formError && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {formError}
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="guardrail-name">Name</Label>
        <Input
          id="guardrail-name"
          value={draft.name}
          onChange={(event) => set("name", event.target.value)}
          placeholder="No client PII outbound"
          aria-invalid={Boolean(fieldErrors.name)}
        />
        <FieldError message={fieldErrors.name} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="guardrail-description">Description</Label>
        <Textarea
          id="guardrail-description"
          value={draft.description}
          onChange={(event) => set("description", event.target.value)}
          placeholder="What this policy is for."
          className="min-h-16"
        />
        <FieldError message={fieldErrors.description} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="guardrail-stage">Stage</Label>
          <Select
            value={draft.stage}
            onValueChange={(value) => set("stage", value as GuardrailPolicyStage)}
          >
            <SelectTrigger id="guardrail-stage" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GUARDRAIL_POLICY_STAGES.map((stage) => (
                <SelectItem key={stage} value={stage}>
                  {STAGE_LABELS[stage]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError message={fieldErrors.stage} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="guardrail-kind">Kind</Label>
          <Select
            value={draft.kind}
            onValueChange={(value) => set("kind", value as GuardrailPolicyKind)}
          >
            <SelectTrigger id="guardrail-kind" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GUARDRAIL_POLICY_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {KIND_LABELS[kind]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError message={fieldErrors.kind} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="guardrail-action">Action</Label>
          <Select
            value={draft.action}
            onValueChange={(value) => set("action", value as GuardrailPolicyAction)}
          >
            <SelectTrigger id="guardrail-action" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GUARDRAIL_POLICY_ACTIONS.map((action) => (
                <SelectItem key={action} value={action}>
                  {ACTION_LABELS[action]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError message={fieldErrors.action} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="guardrail-severity">Severity</Label>
          <Select
            value={draft.severity}
            onValueChange={(value) => set("severity", value as GuardrailPolicySeverity)}
          >
            <SelectTrigger id="guardrail-severity" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GUARDRAIL_POLICY_SEVERITIES.map((severity) => (
                <SelectItem key={severity} value={severity}>
                  {SEVERITY_LABELS[severity]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError message={fieldErrors.severity} />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="guardrail-scope">Scope</Label>
        <Select
          value={draft.scopeType}
          onValueChange={(value) => {
            const scopeType = value as GuardrailPolicyScopeType;
            set("scopeType", scopeType);
            if (scopeType === "company") set("scopeId", "");
          }}
        >
          <SelectTrigger id="guardrail-scope" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GUARDRAIL_POLICY_SCOPE_TYPES.map((scopeType) => (
              <SelectItem key={scopeType} value={scopeType}>
                {SCOPE_LABELS[scopeType]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldError message={fieldErrors.scopeType} />
      </div>

      {draft.scopeType !== "company" && (
        <div className="space-y-2">
          <Label>Applies to</Label>
          <ScopeTargetSelector
            draft={draft}
            fieldError={fieldErrors.scopeId}
            onChange={(scopeType, scopeId) => {
              onChange({ ...draft, scopeType, scopeId });
            }}
          />
        </div>
      )}

      {draft.kind === "allowlist" ? (
        <div className="space-y-2">
          <Label htmlFor="guardrail-values">Allowed values</Label>
          <Textarea
            id="guardrail-values"
            value={draft.values}
            onChange={(event) => set("values", event.target.value)}
            placeholder={"one value per line"}
            className="min-h-28 font-mono text-sm"
            aria-invalid={Boolean(fieldErrors["matcher.values"])}
          />
          <FieldError message={fieldErrors["matcher.values"]} />
        </div>
      ) : draft.kind === "restricted_action" ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="guardrail-tool-names">Tool names</Label>
            <Textarea
              id="guardrail-tool-names"
              value={draft.toolNames}
              onChange={(event) => set("toolNames", event.target.value)}
              placeholder={"google_workspace:gmail_send"}
              className="min-h-20 font-mono text-sm"
              aria-invalid={Boolean(fieldErrors["matcher.toolNames"])}
            />
            <FieldError message={fieldErrors["matcher.toolNames"]} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="guardrail-connector-types">Connector types</Label>
            <Textarea
              id="guardrail-connector-types"
              value={draft.connectorTypes}
              onChange={(event) => set("connectorTypes", event.target.value)}
              placeholder={"google_workspace"}
              className="min-h-20 font-mono text-sm"
              aria-invalid={Boolean(fieldErrors["matcher.connectorTypes"])}
            />
            <FieldError message={fieldErrors["matcher.connectorTypes"]} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="guardrail-argument-patterns">Argument patterns</Label>
            <Textarea
              id="guardrail-argument-patterns"
              value={draft.argumentPatterns}
              onChange={(event) => set("argumentPatterns", event.target.value)}
              placeholder={"recipient=.*@external\\.com"}
              className="min-h-20 font-mono text-sm"
              aria-invalid={Boolean(fieldErrors["matcher.argumentPatterns"])}
            />
            <p className="text-xs text-muted-foreground">
              One <code>path=pattern</code> pair per line.
            </p>
            <FieldError message={fieldErrors["matcher.argumentPatterns"]} />
          </div>
        </div>
      ) : draft.kind === "pii" ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Personal data to match</legend>
          <div className="flex flex-wrap gap-2">
            {PII_TYPE_OPTIONS.map((type) => {
              const active = draft.piiTypes.includes(type);
              return (
                <button
                  key={type}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleType("piiTypes", type)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs transition-colors",
                    active
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent/40",
                  )}
                >
                  {type}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            With none selected, every kind of personal data is matched.
          </p>
          <FieldError message={fieldErrors["matcher.piiTypes"]} />
        </fieldset>
      ) : draft.kind === "secret" ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Credential kinds to match</legend>
          <div className="flex flex-wrap gap-2">
            {SECRET_TYPE_OPTIONS.map((type) => {
              const active = draft.secretTypes.includes(type);
              return (
                <button
                  key={type}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleType("secretTypes", type)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs transition-colors",
                    active
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent/40",
                  )}
                >
                  {type}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            With none selected, every credential kind is matched.
          </p>
          <FieldError message={fieldErrors["matcher.secretTypes"]} />
        </fieldset>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="guardrail-patterns">Patterns</Label>
          <Textarea
            id="guardrail-patterns"
            value={draft.patterns}
            onChange={(event) => set("patterns", event.target.value)}
            placeholder={"\\b\\d{3}-\\d{2}-\\d{4}\\b"}
            className="min-h-28 font-mono text-sm"
            aria-invalid={Boolean(fieldErrors["matcher.patterns"])}
          />
          <FieldError message={fieldErrors["matcher.patterns"]} />
        </div>
      )}

      {draft.kind !== "restricted_action" && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Fields to match</legend>
          <div className="flex flex-wrap gap-2">
            {GUARDRAIL_MATCHER_FIELDS.map((field) => {
              const active = draft.fields.includes(field);
              return (
                <button
                  key={field}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleField(field)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs transition-colors",
                    active
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent/40",
                  )}
                >
                  {MATCHER_FIELD_LABELS[field] ?? field}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            With none selected, every field is matched.
          </p>
          <FieldError message={fieldErrors["matcher.fields"]} />
        </fieldset>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
        <div className="flex items-center gap-2">
          <ToggleSwitch
            checked={draft.enabled}
            onCheckedChange={(checked) => set("enabled", checked)}
            aria-label="Policy enabled"
          />
          <span className="text-sm text-muted-foreground">
            {draft.enabled ? "Enabled" : "Disabled"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Saving…" : submitLabel}
          </Button>
        </div>
      </div>
    </form>
  );
}

export function GuardrailSimulationResults({ result }: { result: GuardrailSimulationResult }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
        <span className="text-muted-foreground">Outcome</span>
        <span
          className={cn(
            "rounded-full border px-2.5 py-0.5 text-xs font-medium",
            ACTION_TONES[result.action],
          )}
        >
          {ACTION_LABELS[result.action]}
        </span>
        <span className="text-muted-foreground">
          {result.matches.length} polic{result.matches.length === 1 ? "y" : "ies"} would fire
        </span>
      </div>

      {result.matches.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No policy would fire on this sample.
        </p>
      ) : (
        <div className="space-y-2">
          {result.matches.map((match) => (
            <div
              key={`${match.policyId}:${match.policyVersion}`}
              className="rounded-md border border-border px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <ShieldAlert className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
                <span className="text-sm font-medium">{match.policyName}</span>
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-xs font-medium",
                    ACTION_TONES[match.action],
                  )}
                >
                  {ACTION_LABELS[match.action]}
                </span>
                <span className={cn("text-xs", SEVERITY_TONES[match.severity])}>
                  {SEVERITY_LABELS[match.severity]}
                </span>
                <span className="text-xs text-muted-foreground">
                  {SCOPE_LABELS[match.scopeType]}
                </span>
                <span className="text-xs text-muted-foreground">v{match.policyVersion}</span>
              </div>
              {match.matchedField && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Matched on {MATCHER_FIELD_LABELS[match.matchedField] ?? match.matchedField}
                </p>
              )}
              {match.excerpt && (
                <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted/40 px-2 py-1 font-mono text-xs text-muted-foreground">
                  {match.excerpt}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}

      {result.decisive && (
        <div className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
          Decided by <span className="font-medium text-foreground">{result.decisive.policyName}</span>
          {result.decisive.scopeType !== "company" && (
            <> ({SCOPE_LABELS[result.decisive.scopeType].toLowerCase()})</>
          )}
        </div>
      )}

      {result.redactedText && (
        <div className="space-y-1">
          <h3 className="text-xs uppercase tracking-widest text-muted-foreground">
            Redacted sample
          </h3>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs">
            {result.redactedText}
          </pre>
        </div>
      )}
    </div>
  );
}

function PolicyListRow({
  policy,
  fires,
  selected,
  onSelect,
  onToggleEnabled,
}: {
  policy: GuardrailPolicy;
  fires: GuardrailFireSummary | undefined;
  selected: boolean;
  onSelect: () => void;
  onToggleEnabled: (enabled: boolean) => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b border-border px-4 py-2.5 transition-colors hover:bg-accent/30",
        selected && "bg-accent/40",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left"
      >
        <span className="flex w-full items-center gap-2">
          <span className="truncate text-sm font-medium">{policy.name}</span>
          {!policy.enabled && (
            <span className="shrink-0 text-xs text-muted-foreground">disabled</span>
          )}
        </span>
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>{STAGE_LABELS[policy.stage]}</span>
          <span aria-hidden="true">·</span>
          <span>{KIND_LABELS[policy.kind]}</span>
          <span aria-hidden="true">·</span>
          <span>{SCOPE_LABELS[policy.scopeType]}</span>
          <span aria-hidden="true">·</span>
          <span>v{policy.version}</span>
          <span aria-hidden="true">·</span>
          <span>
            {fires?.count ?? 0} {fires?.count === 1 ? "fire" : "fires"}
          </span>
          {fires?.lastFiredAt && (
            <>
              <span aria-hidden="true">·</span>
              <span>last {relativeTime(fires.lastFiredAt)}</span>
            </>
          )}
        </span>
      </button>
      <span
        className={cn(
          "shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium",
          ACTION_TONES[policy.action],
        )}
      >
        {ACTION_LABELS[policy.action]}
      </span>
      <span className={cn("shrink-0 text-xs", SEVERITY_TONES[policy.severity])}>
        {SEVERITY_LABELS[policy.severity]}
      </span>
      <ToggleSwitch
        checked={policy.enabled}
        onCheckedChange={onToggleEnabled}
        aria-label={`${policy.enabled ? "Disable" : "Enable"} ${policy.name}`}
      />
    </div>
  );
}

function ViolationRow({
  violation,
  policyName,
}: {
  violation: GuardrailViolation;
  policyName: string | null;
}) {
  const runLink =
    violation.heartbeatRunId && violation.actorAgentId
      ? `/agents/${violation.actorAgentId}/runs/${violation.heartbeatRunId}`
      : null;

  return (
    <div className="flex flex-wrap items-start gap-3 border-b border-border px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-xs font-medium",
              ACTION_TONES[violation.actionTaken],
            )}
          >
            {ACTION_LABELS[violation.actionTaken]}
          </span>
          <span className="text-sm font-medium">
            {policyName ?? (violation.policyId ? `Policy ${violation.policyId.slice(0, 8)}` : "Deleted policy")}
          </span>
          {violation.policyVersion != null && (
            <span className="text-xs text-muted-foreground">v{violation.policyVersion}</span>
          )}
          <span className="text-xs text-muted-foreground">
            {STAGE_LABELS[violation.stage]}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {violation.subjectKind && <span>{violation.subjectKind.replace(/_/g, " ")}</span>}
          <span>· {relativeTime(violation.createdAt)}</span>
          {violation.resolved && <span>· resolved</span>}
        </div>
        {violation.matchedExcerpt && (
          <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted/40 px-2 py-1 font-mono text-xs text-muted-foreground">
            {violation.matchedExcerpt}
          </pre>
        )}
      </div>
      {runLink && (
        <Link
          to={runLink}
          className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          View run
        </Link>
      )}
    </div>
  );
}

export function Guardrails() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();

  const [stageFilter, setStageFilter] = useState<string>(ALL_SCOPE_OPTIONS);
  const [scopeFilter, setScopeFilter] = useState<string>(ALL_SCOPE_OPTIONS);
  const [selectedPolicyId, setSelectedPolicyId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<PolicyDraft>(emptyDraft);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const [simulateStage, setSimulateStage] = useState<GuardrailPolicyStage>("input");
  const [simulateSample, setSimulateSample] = useState("");
  /**
   * Which part of the studio the sample is pretending to be. A policy that
   * restricts itself to one field — "comments" or "issue titles" — only fires
   * on that field, so the simulator has to know where the sample would land
   * or a field-scoped policy would silently never match.
   */
  const [simulateField, setSimulateField] = useState<string>("comment");
  const [simulation, setSimulation] = useState<GuardrailSimulationResult | null>(null);
  const [simulationError, setSimulationError] = useState<string | null>(null);
  /**
   * Whether the draft being edited is also evaluated by the simulator. It is
   * on by default, because the point of the simulator is to test a policy
   * before it is saved.
   */
  const [simulateDraft, setSimulateDraft] = useState(true);

  /**
   * The unsaved draft as the simulator sees it. It is only sent when the
   * draft passes the shared schema, so the simulator never receives a policy
   * the server would reject.
   */
  const simulateCandidate = useMemo<GuardrailPolicyBodyCandidate | null>(() => {
    if (!simulateDraft || !editing) return null;
    return draftToSimulationCandidate(draft);
  }, [draft, editing, simulateDraft]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Company Settings", href: "/company/settings" }, { label: "Guardrails" }]);
  }, [setBreadcrumbs]);

  const policiesQuery = useQuery({
    queryKey: queryKeys.guardrails.policies(selectedCompanyId ?? ""),
    queryFn: () => guardrailsApi.listPolicies(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const violationsQuery = useQuery({
    queryKey: queryKeys.guardrails.violations(selectedCompanyId ?? ""),
    queryFn: () => guardrailsApi.listViolations(selectedCompanyId!, { limit: 500 }),
    enabled: Boolean(selectedCompanyId),
  });

  const policies = policiesQuery.data ?? [];
  const violations = violationsQuery.data ?? [];

  /**
   * How often each policy has fired, derived from the violations the company
   * has recorded. The policy row carries no counter of its own.
   */
  const firesByPolicy = useMemo(() => summariseFiresByPolicy(violations), [violations]);

  /**
   * The saved policies the simulator evaluates.
   *
   * The endpoint only evaluates the policies it is given, so they have to be
   * named explicitly. Without this, a draft under test would be evaluated on
   * its own while every saved policy was silently ignored — the opposite of
   * what an author is asking the simulator to do.
   */
  const simulatePolicyIds = useMemo(
    () =>
      policies
        .filter((policy) => policy.enabled && policy.stage === simulateStage)
        .map((policy) => policy.id),
    [policies, simulateStage],
  );

  const filteredPolicies = useMemo(
    () =>
      policies.filter((policy) => {
        if (stageFilter !== ALL_SCOPE_OPTIONS && policy.stage !== stageFilter) return false;
        if (scopeFilter !== ALL_SCOPE_OPTIONS && policy.scopeType !== scopeFilter) return false;
        return true;
      }),
    [policies, scopeFilter, stageFilter],
  );

  const selectedPolicy = useMemo(
    () => policies.find((policy) => policy.id === selectedPolicyId) ?? null,
    [policies, selectedPolicyId],
  );

  const invalidatePolicies = async () => {
    await queryClient.invalidateQueries({
      queryKey: queryKeys.guardrails.policies(selectedCompanyId ?? ""),
    });
  };

  const createPolicy = useMutation({
    mutationFn: (payload: CreateGuardrailPolicy) =>
      guardrailsApi.createPolicy(selectedCompanyId!, payload),
    onSuccess: async (policy) => {
      await invalidatePolicies();
      setEditing(false);
      setSelectedPolicyId(policy.id);
      setFieldErrors({});
      setFormError(null);
      pushToast({
        tone: "success",
        title: "Policy created",
        body: `${policy.name} is now ${policy.enabled ? "enabled" : "disabled"}.`,
      });
    },
    onError: (error) => {
      const apiFieldErrors = extractApiFieldErrors(error);
      setFieldErrors(apiFieldErrors);
      setFormError(
        Object.keys(apiFieldErrors).length > 0
          ? "Fix the highlighted fields and try again."
          : errorMessage(error),
      );
    },
  });

  const updatePolicy = useMutation({
    mutationFn: (payload: Partial<CreateGuardrailPolicy>) =>
      guardrailsApi.updatePolicy(selectedCompanyId!, selectedPolicyId!, payload),
    onSuccess: async (policy) => {
      await invalidatePolicies();
      setEditing(false);
      setFieldErrors({});
      setFormError(null);
      pushToast({
        tone: "success",
        title: "Policy saved",
        body: `${policy.name} is now at version ${policy.version}.`,
      });
    },
    onError: (error) => {
      const apiFieldErrors = extractApiFieldErrors(error);
      setFieldErrors(apiFieldErrors);
      setFormError(
        Object.keys(apiFieldErrors).length > 0
          ? "Fix the highlighted fields and try again."
          : errorMessage(error),
      );
    },
  });

  const togglePolicy = useMutation({
    mutationFn: (input: { policyId: string; enabled: boolean }) =>
      guardrailsApi.updatePolicy(selectedCompanyId!, input.policyId, { enabled: input.enabled }),
    onSuccess: (policy) => {
      void invalidatePolicies();
      pushToast({
        tone: "success",
        title: policy.enabled ? "Policy enabled" : "Policy disabled",
        body: policy.name,
      });
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "Update failed", body: errorMessage(error) });
    },
  });

  const deletePolicy = useMutation({
    mutationFn: (policyId: string) => guardrailsApi.deletePolicy(selectedCompanyId!, policyId),
    onSuccess: async () => {
      await invalidatePolicies();
      setSelectedPolicyId(null);
      setEditing(false);
      pushToast({ tone: "success", title: "Policy deleted", body: "The policy was removed." });
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "Delete failed", body: errorMessage(error) });
    },
  });

  const simulate = useMutation({
    mutationFn: () =>
      guardrailsApi.simulate(selectedCompanyId!, {
        stage: simulateStage,
        subject: simulateSample,
        subjectFields: { [simulateField]: simulateSample },
        policyIds: simulatePolicyIds,
        candidatePolicy: simulateCandidate,
      }),
    onSuccess: (result) => {
      setSimulation(result);
      setSimulationError(null);
    },
    onError: (error) => {
      setSimulation(null);
      setSimulationError(errorMessage(error));
    },
  });

  function startCreate() {
    setDraft(emptyDraft());
    setFieldErrors({});
    setFormError(null);
    setSelectedPolicyId(null);
    setEditing(true);
  }

  function startEdit(policy: GuardrailPolicy) {
    setDraft(draftFromPolicy(policy));
    setFieldErrors({});
    setFormError(null);
    setSelectedPolicyId(policy.id);
    setEditing(true);
  }

  function submitPolicy() {
    const { fieldErrors: draftFieldErrors, payload } = validateDraft(draft);
    if (!payload) {
      setFieldErrors(draftFieldErrors);
      setFormError("Fix the highlighted fields and try again.");
      return;
    }
    setFieldErrors({});
    setFormError(null);
    if (selectedPolicyId) {
      updatePolicy.mutate(payload);
    } else {
      createPolicy.mutate(payload);
    }
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={ShieldCheck} message="Select a company to manage guardrails." />;
  }

  const isSaving = createPolicy.isPending || updatePolicy.isPending;

  return (
    <div className="flex min-h-0 flex-col gap-0 xl:flex-row">
      <div className="min-w-0 flex-1 xl:border-r xl:border-border">
        <Tabs defaultValue="policies" className="flex min-h-0 flex-col">
          <div className="border-b border-border px-4 py-3">
            <TabsList>
              <TabsTrigger value="policies">Policies</TabsTrigger>
              <TabsTrigger value="simulation">Simulation</TabsTrigger>
              <TabsTrigger value="violations">Violations</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="policies" className="mt-0">
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
              <Select value={stageFilter} onValueChange={setStageFilter}>
                <SelectTrigger size="sm" className="w-40" aria-label="Filter by stage">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_SCOPE_OPTIONS}>All stages</SelectItem>
                  {GUARDRAIL_POLICY_STAGES.map((stage) => (
                    <SelectItem key={stage} value={stage}>
                      {STAGE_LABELS[stage]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={scopeFilter} onValueChange={setScopeFilter}>
                <SelectTrigger size="sm" className="w-44" aria-label="Filter by scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_SCOPE_OPTIONS}>All scopes</SelectItem>
                  {GUARDRAIL_POLICY_SCOPE_TYPES.map((scopeType) => (
                    <SelectItem key={scopeType} value={scopeType}>
                      {SCOPE_LABELS[scopeType]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">
                {filteredPolicies.length} of {policies.length}
              </span>
              <Button size="sm" onClick={startCreate} className="ml-auto">
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                New policy
              </Button>
            </div>

            {policiesQuery.isLoading ? (
              <PageSkeleton variant="list" />
            ) : policiesQuery.error ? (
              <div className="px-4 py-6 text-sm text-destructive">
                {errorMessage(policiesQuery.error)}
              </div>
            ) : filteredPolicies.length === 0 ? (
              <EmptyState
                icon={ShieldCheck}
                message={
                  policies.length === 0
                    ? "No guardrail policies yet. Create one to control what agents can send and do."
                    : "No policies match this filter."
                }
                action={policies.length === 0 ? "New policy" : undefined}
                onAction={policies.length === 0 ? startCreate : undefined}
              />
            ) : (
              <div>
                {filteredPolicies.map((policy) => (
                  <PolicyListRow
                    key={policy.id}
                    policy={policy}
                    fires={firesByPolicy.get(policy.id)}
                    selected={policy.id === selectedPolicyId}
                    onSelect={() => {
                      setSelectedPolicyId(policy.id);
                      setEditing(false);
                      setFieldErrors({});
                      setFormError(null);
                    }}
                    onToggleEnabled={(enabled) =>
                      togglePolicy.mutate({ policyId: policy.id, enabled })
                    }
                  />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="simulation" className="mt-0">
            <div className="space-y-4 px-4 py-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="space-y-2">
                  <Label htmlFor="guardrail-simulate-stage">Sample stage</Label>
                  <Select
                    value={simulateStage}
                    onValueChange={(value) => setSimulateStage(value as GuardrailPolicyStage)}
                  >
                    <SelectTrigger id="guardrail-simulate-stage" className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {GUARDRAIL_POLICY_STAGES.map((stage) => (
                        <SelectItem key={stage} value={stage}>
                          {STAGE_LABELS[stage]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="guardrail-simulate-field">Sample is written to</Label>
                  <Select value={simulateField} onValueChange={setSimulateField}>
                    <SelectTrigger id="guardrail-simulate-field" className="w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {GUARDRAIL_MATCHER_FIELDS.filter((field) => field !== "any").map((field) => (
                        <SelectItem key={field} value={field}>
                          {MATCHER_FIELD_LABELS[field] ?? field}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  size="sm"
                  onClick={() => simulate.mutate()}
                  disabled={simulate.isPending || simulateSample.trim().length === 0}
                >
                  <Play className="mr-1.5 h-3.5 w-3.5" />
                  {simulate.isPending ? "Simulating…" : "Simulate"}
                </Button>
              </div>

              <div className="space-y-2">
                <Label htmlFor="guardrail-simulate-sample">
                  {simulateStage === "output" ? "Sample agent output" : "Sample agent input"}
                </Label>
                <Textarea
                  id="guardrail-simulate-sample"
                  value={simulateSample}
                  onChange={(event) => setSimulateSample(event.target.value)}
                  placeholder="Paste the text you want to test against the current policies."
                  className="min-h-40 font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  Tested as {MATCHER_FIELD_LABELS[simulateField]?.toLowerCase() ?? simulateField},
                  alongside the {simulatePolicyIds.length} saved{" "}
                  {simulatePolicyIds.length === 1 ? "policy" : "policies"} for this stage.
                </p>
              </div>

              <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <ToggleSwitch
                    checked={simulateDraft}
                    onCheckedChange={setSimulateDraft}
                    aria-label="Include the policy being edited"
                  />
                  <span className="text-sm font-medium">Include the policy being edited</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {editing
                    ? simulateCandidate
                      ? `The unsaved draft "${draft.name.trim() || "Untitled policy"}" is evaluated alongside the saved policies.`
                      : "The draft is not valid yet, so only the saved policies are evaluated. Fix the highlighted fields to test the draft."
                    : "Open a policy in the editor to test an unsaved draft before you save it."}
                </p>
              </div>

              {simulationError && (
                <div
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  {simulationError}
                </div>
              )}

              {simulation && <GuardrailSimulationResults result={simulation} />}
            </div>
          </TabsContent>

          <TabsContent value="violations" className="mt-0">
            {violationsQuery.isLoading ? (
              <PageSkeleton variant="list" />
            ) : violationsQuery.error ? (
              <div className="px-4 py-6 text-sm text-destructive">
                {errorMessage(violationsQuery.error)}
              </div>
            ) : violations.length === 0 ? (
              <EmptyState
                icon={ShieldCheck}
                message="No violations recorded. Every guardrail decision so far was an allow."
              />
            ) : (
              <div>
                {violations.map((violation) => (
                  <ViolationRow
                    key={violation.id}
                    violation={violation}
                    policyName={
                      violation.policyId
                        ? (policies.find((policy) => policy.id === violation.policyId)?.name ?? null)
                        : null
                    }
                  />
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>

      <div className="w-full shrink-0 px-4 py-4 xl:w-96 xl:max-w-96">
        {editing ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-lg font-semibold">
                {selectedPolicyId ? "Edit policy" : "New policy"}
              </h2>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close editor"
                onClick={() => {
                  setEditing(false);
                  setFieldErrors({});
                  setFormError(null);
                }}
              >
                <Ban className="h-4 w-4" />
              </Button>
            </div>
            <GuardrailPolicyEditor
              draft={draft}
              fieldErrors={fieldErrors}
              formError={formError}
              isPending={isSaving}
              submitLabel={selectedPolicyId ? "Save policy" : "Create policy"}
              onChange={setDraft}
              onSubmit={submitPolicy}
              onCancel={() => {
                setEditing(false);
                setFieldErrors({});
                setFormError(null);
              }}
            />
          </div>
        ) : selectedPolicy ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold">{selectedPolicy.name}</h2>
                <p className="text-xs text-muted-foreground">
                  {KIND_LABELS[selectedPolicy.kind]} · {STAGE_LABELS[selectedPolicy.stage]} ·
                  version {selectedPolicy.version}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => startEdit(selectedPolicy)}>
                  <Pencil className="mr-1.5 h-3.5 w-3.5" />
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${selectedPolicy.name}`}
                  onClick={() => deletePolicy.mutate(selectedPolicy.id)}
                  disabled={deletePolicy.isPending}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {selectedPolicy.description && (
              <p className="text-sm text-muted-foreground">{selectedPolicy.description}</p>
            )}

            <dl className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">Action</dt>
                <dd>
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-xs font-medium",
                      ACTION_TONES[selectedPolicy.action],
                    )}
                  >
                    {ACTION_LABELS[selectedPolicy.action]}
                  </span>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">Severity</dt>
                <dd className={cn("text-xs", SEVERITY_TONES[selectedPolicy.severity])}>
                  {SEVERITY_LABELS[selectedPolicy.severity]}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">Scope</dt>
                <dd className="truncate text-xs">{SCOPE_LABELS[selectedPolicy.scopeType]}</dd>
              </div>
            </dl>

            <div>
              <h3 className="text-xs uppercase tracking-widest text-muted-foreground">Matcher</h3>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs">
                {JSON.stringify(selectedPolicy.matcher, null, 2)}
              </pre>
            </div>
          </div>
        ) : (
          <EmptyState
            icon={ShieldCheck}
            message="Select a policy to inspect it, or create a new one."
          />
        )}
      </div>
    </div>
  );
}
