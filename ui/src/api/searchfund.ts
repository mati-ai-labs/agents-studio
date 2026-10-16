import { api } from "./client";

export type SearchfundNiche = {
  id: string;
  taxonomyId: string;
  shortName: string;
  fields: Array<{ header: string; value: string }>;
  researchStatus: string | null;
  runStatus: string | null;
  sheetRow: number | null;
  updatedAt: string;
  decisionScore: number | null;
  linkedIssue: { id: string; identifier: string | null; status: string | null; title: string | null } | null;
};

export type SearchfundLayer = { weight: number; opportunity: number | null; decision: number | null; confidence: number | null };
export type SearchfundCriterion = { raw: number | null; confidence: number | null; adjusted: number | null };

export type SearchfundScore = {
  id: string;
  rank: number | null;
  subniche: string;
  taxonomyId: string | null;
  issue: string | null;
  scoringStatus: string | null;
  decisionScore: number | null;
  nicheSummary: {
    opportunity_score?: number | null;
    decision_score?: number | null;
    evidence_confidence?: number | null;
    coverage_pct?: number | null;
    completeness_pct?: number | null;
    recommendation?: string | null;
    l0_gate_status?: string | null;
    l0_qualification?: string | null;
    overall_justification?: string | null;
    primary_reason?: string | null;
    next_step?: string | null;
    [key: string]: unknown;
  };
  crossNicheSummary: { criteria_adjusted?: Record<string, number | null> } | null;
  crossNicheComparison: {
    layers?: Record<string, SearchfundLayer>;
    criteria?: Record<string, SearchfundCriterion>;
  } | null;
  details: {
    layers?: unknown[][];
    criteria?: unknown[][];
    noncore?: unknown[][];
  } | null;
  generatedAt: string | null;
  updatedAt: string;
};

export type SearchfundFile = {
  id: string;
  filename: string;
  issue: string | null;
  taxonomyId: string | null;
  nicheName: string | null;
  contentType: string;
  byteSize: number;
  updatedAt: string;
};

export type SearchfundWorkbookName = "dashboard" | "scoring";
export type SearchfundWorkbookTab = { tab: string; position: number; rowCount: number; colCount: number; syncedAt: string };
export type SearchfundWorkbooks = Array<{ workbook: SearchfundWorkbookName; tabs: SearchfundWorkbookTab[] }>;
export type SearchfundSheet = { workbook: string; tab: string; rows: string[][]; syncedAt: string };

export type SearchfundMetric = { name?: string; value?: unknown; unit?: string; period?: string; geography?: string; observation_type?: string };
export type SearchfundEvidence = {
  source_id?: string; source_name?: string; publisher?: string; source_type?: string; data_date?: string;
  directness?: string; claim_supported?: string; url?: string;
};
export type SearchfundCriterionDoc = {
  criterion_id?: string; criterion_name?: string; scope?: string; research_status?: string; gate_status?: string | null;
  overlay_status?: string | null; preliminary_signal?: string; confidence?: string; metrics?: SearchfundMetric[];
  finding?: string; interpretation?: string; evidence?: SearchfundEvidence[]; contradictions?: string[]; limitations?: string[];
  missing_data?: string[]; recommended_next_step?: string; provisional_score_1_10?: number | null; calculation?: string;
};
export type SearchfundLayerDoc = {
  layerId: string;
  layerIssue: string | null;
  updatedAt: string;
  doc: {
    layer?: { id?: string; name?: string };
    layer_summary?: string;
    niche_boundary?: { micro_niche?: string; niche?: string; sub_niche?: string; inclusions?: string[]; exclusions?: string[]; classification_notes?: string[] };
    run_metadata?: { as_of_date?: string; mode?: string; geography?: string; research_version?: string };
    criteria?: SearchfundCriterionDoc[];
    sources_consulted?: string[];
    open_questions?: string[];
  };
};

export type SearchfundColumnType = "rank" | "text" | "longtext" | "score" | "number" | "percent" | "weight" | "status" | "date";
export type SearchfundColorScale = { min: number; mid?: number; max: number; colors: string[] };
export type SearchfundColumn = {
  key: string;
  label: string;
  type: SearchfundColumnType;
  group?: string;
  subgroup?: string;
  /** The sheet's colour scale for this column (min → mid → max). */
  scale?: SearchfundColorScale;
  /** The sheet's per-value cell colours. */
  highlight?: Record<string, { bg: string; fg: string }>;
  note?: string;
};
export type SearchfundTable = { key: string; title: string; description: string; columns: SearchfundColumn[]; rows: Array<Array<string | number | null>> };
export type SearchfundFacet = { value: string; count: number };
export type SearchfundPage<T> = { total: number; page: number; pageSize: number; rows: T[] };
export type SearchfundNicheRow = {
  id: string;
  taxonomyId: string;
  shortName: string;
  runStatus: string | null;
  row: Record<string, string>;
  linkedIssue: { id: string; identifier: string | null; status: string | null; title: string | null } | null;
};
export type SearchfundNicheColumns = {
  columns: SearchfundColumn[];
  stats: { total: number; finished: number; running: number; notStarted: number };
};
export type SearchfundTableSummary = SearchfundTable & { rowCount: number };
export type SearchfundDimension = {
  dimension: string;
  weight: number;
  derivation: string;
  score1: string;
  score5: string;
  scoreColumn: string | null;
};
export type SearchfundScoringModel = {
  source: "studio" | "sheet" | null;
  updatedAt: string | null;
  dimensions: SearchfundDimension[];
  notes: string[];
  updatedNiches?: number;
};
export type SearchfundRun = {
  issue: string; microNiche: string | null; niche: string | null; asOf: string | null; layers: string[]; updatedAt: string;
  subniche: string | null; taxonomyId: string | null; scoringStatus: string | null; decisionScore: number | null; rank: number | null; fileId: string | null;
};

export type SearchfundRunResult = { routineRunId: string; status: string; linkedIssueId: string | null; issueIdentifier: string | null; via: "webhook" | "api" };

export const searchfundApi = {
  access: (companyId: string) => api.get<{ allowed: boolean }>(`/companies/${companyId}/searchfund/access`),
  niches: (companyId: string) => api.get<SearchfundNiche[]>(`/companies/${companyId}/searchfund/niches`),
  runNiche: (companyId: string, nicheId: string, idempotencyKey: string) =>
    api.post<SearchfundRunResult>(`/companies/${companyId}/searchfund/niches/${nicheId}/run`, { idempotencyKey }),
  scores: (companyId: string) => api.get<SearchfundScore[]>(`/companies/${companyId}/searchfund/scores`),
  scoring: (companyId: string) => api.get<SearchfundTableSummary[]>(`/companies/${companyId}/searchfund/scoring`),
  scoringPage: (companyId: string, table: string, params: string) =>
    api.get<SearchfundPage<Array<string | number | null>>>(`/companies/${companyId}/searchfund/scoring/${encodeURIComponent(table)}/query?${params}`),
  scoringFacets: (companyId: string, table: string, params: string) =>
    api.get<SearchfundFacet[]>(`/companies/${companyId}/searchfund/scoring/${encodeURIComponent(table)}/facets?${params}`),
  scoringModel: (companyId: string) => api.get<SearchfundScoringModel>(`/companies/${companyId}/searchfund/scoring-model`),
  saveScoringModel: (companyId: string, dimensions: Array<Omit<SearchfundDimension, "scoreColumn">>) =>
    api.put<SearchfundScoringModel>(`/companies/${companyId}/searchfund/scoring-model`, { dimensions }),
  resetScoringModel: (companyId: string) => api.delete<SearchfundScoringModel>(`/companies/${companyId}/searchfund/scoring-model`),
  nicheColumns: (companyId: string) => api.get<SearchfundNicheColumns>(`/companies/${companyId}/searchfund/niches/columns`),
  nichePage: (companyId: string, params: string) =>
    api.get<SearchfundPage<SearchfundNicheRow>>(`/companies/${companyId}/searchfund/niches/query?${params}`),
  nicheFacets: (companyId: string, params: string) =>
    api.get<SearchfundFacet[]>(`/companies/${companyId}/searchfund/niches/facets?${params}`),
  runs: (companyId: string) => api.get<SearchfundRun[]>(`/companies/${companyId}/searchfund/runs`),
  files: (companyId: string) => api.get<SearchfundFile[]>(`/companies/${companyId}/searchfund/files`),
  workbooks: (companyId: string) => api.get<SearchfundWorkbooks>(`/companies/${companyId}/searchfund/workbooks`),
  sheet: (companyId: string, workbook: string, tab: string) =>
    api.get<SearchfundSheet>(`/companies/${companyId}/searchfund/workbooks/${workbook}/tabs/${encodeURIComponent(tab)}`),
  runLayers: (companyId: string, issue: string) =>
    api.get<SearchfundLayerDoc[]>(`/companies/${companyId}/searchfund/runs/${encodeURIComponent(issue)}/layers`),
  harvest: (companyId: string, issue?: string) =>
    api.post<unknown>(`/companies/${companyId}/searchfund/harvest`, issue ? { issue } : {}),
};
