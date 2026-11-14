import type { EvalCohortComparison } from "@paperclipai/shared";
import { api } from "./client";

export type ClassifierDecision = "allow" | "deny" | "approval" | "error";

export interface ClassifierCaseResult {
  id: string;
  tool: string;
  action: string;
  expect: Exclude<ClassifierDecision, "error">;
  decision: ClassifierDecision;
  ok: boolean;
  ruleName: string | null;
  reason: string;
  ms: number;
}

export interface ClassifierRunSummary {
  total: number;
  correct: number;
  accuracy: number;
  missed: number;
  falseStops: number;
  wrongKind: number;
  errors: number;
  avgMs: number;
}

export interface ClassifierRun {
  id: string;
  model: string;
  evaluatedAt: string;
  passed: boolean;
  summary: ClassifierRunSummary;
  results: ClassifierCaseResult[];
  rules: Array<{ name: string; rule: string; action: string }>;
  companyRules: Array<{ name: string; rule: string; action: string }>;
  preview: Array<{ id: string; action: string; decision: ClassifierDecision; ruleName: string | null; reason: string }>;
}

/** A stored eval result row (GET /evals/results). */
export interface EvalResultRow {
  id: string;
  scenarioId: string;
  bundleId: string;
  status: "passed" | "failed" | "error";
  score: number;
  checks: Array<{ kind: string; name: string; passed: boolean; detail: string; observed?: Record<string, unknown> }>;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
  error: string | null;
  evaluatedAt: string;
}

const base = (companyId: string) => `/companies/${encodeURIComponent(companyId)}`;

export const evalsApi = {
  runClassifier: (companyId: string) => api.post<ClassifierRun>(`${base(companyId)}/evals/classifier-run`, {}),
  listResults: (companyId: string, scenarioId?: string) =>
    api.get<EvalResultRow[]>(
      `${base(companyId)}/evals/results${scenarioId ? `?scenarioId=${encodeURIComponent(scenarioId)}` : ""}`,
    ),
  agentCohorts: (companyId: string, thresholdDays?: number) =>
    api.get<EvalCohortComparison>(
      `${base(companyId)}/costs/agent-cohorts${thresholdDays ? `?thresholdDays=${thresholdDays}` : ""}`,
    ),
};
