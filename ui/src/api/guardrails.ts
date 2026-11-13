import type {
  CreateGuardrailPolicy,
  GuardrailMatcher,
  GuardrailPolicyAction,
  GuardrailPolicyKind,
  GuardrailPolicyScopeType,
  GuardrailPolicySeverity,
  GuardrailPolicyStage,
  GuardrailViolationsQuery,
  UpdateGuardrailPolicy,
} from "@paperclipai/shared";
import { api } from "./client";

export type {
  CreateGuardrailPolicy,
  GuardrailMatcher,
  GuardrailPolicyAction,
  GuardrailPolicyKind,
  GuardrailPolicyScopeType,
  GuardrailPolicySeverity,
  GuardrailPolicyStage,
  GuardrailViolationsQuery,
  UpdateGuardrailPolicy,
};

/**
 * A policy as the API returns it: the stored row plus the fields the studio
 * keeps on it. `matcher` is the self-describing matcher the policy kind
 * discriminated union expects, so it always carries its own `kind`.
 */
export interface GuardrailPolicy {
  id: string;
  companyId: string;
  scopeType: GuardrailPolicyScopeType;
  scopeId: string | null;
  stage: GuardrailPolicyStage;
  name: string;
  description: string | null;
  kind: GuardrailPolicyKind;
  matcher: GuardrailMatcher;
  action: GuardrailPolicyAction;
  severity: GuardrailPolicySeverity;
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * One policy that matched a simulated subject, and what it would do. The
 * excerpt is already scrubbed by the server, so it is safe to render.
 */
export interface GuardrailSimulationMatch {
  policyId: string;
  policyName: string;
  kind: GuardrailPolicyKind;
  action: GuardrailPolicyAction;
  severity: GuardrailPolicySeverity;
  scopeType: GuardrailPolicyScopeType;
  scopeId: string | null;
  policyVersion: number;
  matchedField: string | null;
  excerpt: string;
}

/**
 * The outcome of simulating a sample against a policy set.
 */
export interface GuardrailSimulationResult {
  action: GuardrailPolicyAction;
  decisive: GuardrailSimulationMatch | null;
  matches: GuardrailSimulationMatch[];
  redactedText: string | null;
}

/**
 * A recorded non-`allow` decision. `heartbeatRunId` names the run that
 * triggered it, which is what the studio links back to.
 */
export interface GuardrailViolation {
  id: string;
  companyId: string;
  policyId: string | null;
  policyVersion: number | null;
  stage: GuardrailPolicyStage;
  actionTaken: GuardrailPolicyAction;
  actorAgentId: string | null;
  heartbeatRunId: string | null;
  subjectKind: string;
  subjectId: string | null;
  matchedExcerpt: string | null;
  resolved: boolean;
  createdAt: string;
}

/**
 * The body the simulate endpoint takes: a sample subject plus the policies to
 * evaluate against it. `candidatePolicy` is an unsaved policy the author is
 * still drafting, so it can be tested before it is saved.
 */
export interface GuardrailSimulationRequest {
  stage: GuardrailPolicyStage;
  subject?: string | null;
  subjectFields?: Record<string, string> | null;
  toolName?: string | null;
  connectorType?: string | null;
  toolArguments?: Record<string, unknown> | null;
  candidatePolicy?: GuardrailPolicyBodyCandidate | null;
  policyIds?: string[] | null;
  agentId?: string | null;
  projectId?: string | null;
  goalId?: string | null;
}

/**
 * The subset of a policy body the simulate endpoint accepts as a candidate.
 */
export interface GuardrailPolicyBodyCandidate {
  scopeType: GuardrailPolicyScopeType;
  scopeId?: string | null;
  stage: GuardrailPolicyStage;
  name: string;
  description?: string | null;
  kind: GuardrailPolicyKind;
  matcher?: GuardrailMatcher | null;
  action: GuardrailPolicyAction;
  severity: GuardrailPolicySeverity;
  enabled?: boolean;
}

/**
 * The query the violations endpoint accepts. `limit` and `offset` have
 * server-side defaults, so the caller only sends what it wants to override.
 */
export type GuardrailViolationsQueryInput = Partial<GuardrailViolationsQuery>;

function violationsQueryString(query?: GuardrailViolationsQueryInput): string {
  if (!query) return "";
  const params = new URLSearchParams();
  if (query.policyId) params.set("policyId", query.policyId);
  if (query.stage) params.set("stage", query.stage);
  if (query.agentId) params.set("agentId", query.agentId);
  if (query.runId) params.set("runId", query.runId);
  if (query.action) params.set("action", query.action);
  if (query.resolved !== undefined) params.set("resolved", query.resolved);
  if (query.since) params.set("since", query.since);
  if (query.until) params.set("until", query.until);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.offset !== undefined) params.set("offset", String(query.offset));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const guardrailsApi = {
  listPolicies: (companyId: string) =>
    api.get<GuardrailPolicy[]>(
      `/companies/${encodeURIComponent(companyId)}/guardrail-policies`,
    ),
  createPolicy: (companyId: string, payload: CreateGuardrailPolicy) =>
    api.post<GuardrailPolicy>(
      `/companies/${encodeURIComponent(companyId)}/guardrail-policies`,
      payload,
    ),
  updatePolicy: (companyId: string, policyId: string, payload: UpdateGuardrailPolicy) =>
    api.patch<GuardrailPolicy>(
      `/companies/${encodeURIComponent(companyId)}/guardrail-policies/${encodeURIComponent(policyId)}`,
      payload,
    ),
  deletePolicy: (companyId: string, policyId: string) =>
    api.delete<GuardrailPolicy>(
      `/companies/${encodeURIComponent(companyId)}/guardrail-policies/${encodeURIComponent(policyId)}`,
    ),
  simulate: (companyId: string, payload: GuardrailSimulationRequest) =>
    api.post<GuardrailSimulationResult>(
      `/companies/${encodeURIComponent(companyId)}/guardrail-policies/simulate`,
      payload,
    ),
  listViolations: (companyId: string, query?: GuardrailViolationsQueryInput) =>
    api.get<GuardrailViolation[]>(
      `/companies/${encodeURIComponent(companyId)}/guardrail-violations${violationsQueryString(query)}`,
    ),
};
