// Builds the Scoring workbook's tabs from the stored score.py JSON, row for row the way the
// scoring sheet writer lays them out (nicheSummaryRow_, summaryRow_, comparisonRow_, detail tabs),
// plus the parts of the result the sheet never shows (L0 gates, L7 overlays, L8 audit, gap queue).
import { SEARCHFUND_CATALOG } from "./searchfund-catalog.js";

export type ColumnType = "rank" | "text" | "longtext" | "score" | "number" | "percent" | "weight" | "status" | "date";
/** A sheet colour scale: colours spread over min → (mid) → max of the column, as Google Sheets does. */
export type ColorScale = { min: number; mid?: number; max: number; colors: string[] };
/** Per-value cell colours (the sheet's "text is exactly" rules). */
export type Highlight = Record<string, { bg: string; fg: string }>;
export type TableColumn = {
  key: string;
  label: string;
  type: ColumnType;
  group?: string;
  subgroup?: string;
  scale?: ColorScale;
  highlight?: Highlight;
  note?: string;
};
export type ScoringTable = { key: string; title: string; description: string; columns: TableColumn[]; rows: Array<Array<string | number | null>> };

type Json = Record<string, unknown>;
type ScoreRow = {
  rank: number | null;
  subniche: string;
  nicheSummary: Json;
  crossNicheSummary: Json | null;
  crossNicheComparison: Json | null;
  details: Json | null;
  result: Json | null;
};

const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const val = (v: unknown): string | number | null =>
  v === undefined || v === null || v === "" ? null : typeof v === "number" ? v : typeof v === "string" ? v : JSON.stringify(v);
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.replace(/[%,]/g, "")))) return Number(v.replace(/[%,]/g, ""));
  return null;
};
const col = (key: string, label: string, type: ColumnType, group?: string, subgroup?: string): TableColumn => ({ key, label, type, group, subgroup });
const slug = (s: string) => s.toLowerCase().replace(/&/g, " ").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

const HEAD_COLUMNS = [
  col("rank", "Rank", "rank"),
  col("subniche", "Subniche", "text"),
  col("opportunity", "Opportunity Score", "score"),
  col("decision", "Decision Score", "score"),
  col("confidence", "Evidence Confidence", "score"),
  col("coverage", "Coverage %", "percent"),
  col("recommendation", "Recommendation", "status"),
];

/**
 * Overall opportunity / decision score. score.py leaves the point score empty when evidence coverage is below 100%
 * and gives its possible range instead (overall.opportunity_bounds / decision_bounds); show that range, e.g. "56.7–58.2".
 */
function overallScore(r: ScoreRow, value: unknown, kind: "opportunity" | "decision") {
  if (num(value) !== null) return val(value);
  const overall = isRecord(r.result?.overall) ? (r.result!.overall as Json) : {};
  const bounds = Array.isArray(overall[`${kind}_bounds`]) ? (overall[`${kind}_bounds`] as unknown[]).map(num) : [];
  if (bounds.length === 2 && bounds[0] !== null && bounds[1] !== null) return `${bounds[0].toFixed(1)}–${bounds[1].toFixed(1)}`;
  return val(value);
}

function head(r: ScoreRow, h: Json) {
  return [
    r.rank, r.subniche, overallScore(r, h.opportunity_score, "opportunity"), overallScore(r, h.decision_score, "decision"),
    val(h.evidence_confidence), val(h.coverage_pct), val(h.recommendation),
  ];
}

// The scoring sheet's conditional formatting: red → yellow → green at min / 50th percentile / max, per column.
const SCORING_SCALE_COLORS = ["#f8696b", "#ffeb84", "#63be7b"];
const SCORING_SCALED_COLUMNS: Record<string, string[]> = {
  niche_summary: ["opportunity", "decision"],
  cross_niche_summary: ["opportunity", "decision"],
  cross_niche_comparison: ["opportunity", "decision", ...SEARCHFUND_CATALOG.map((l) => `${l.id}.decision`)],
  layer_detail: ["opportunity", "decision"],
  criteria_detail: ["adjusted"],
};

/** Sheets' colour-scale anchors for a column: min, PERCENTILE(50) (linear interpolation), max. */
export function colorScale(values: unknown[], colors: string[], withMid: boolean): ColorScale | undefined {
  const nums = values.map(num).filter((n): n is number => n !== null).sort((a, b) => a - b);
  if (!nums.length) return undefined;
  const pos = (nums.length - 1) * 0.5;
  const mid = nums[Math.floor(pos)] + (nums[Math.ceil(pos)] - nums[Math.floor(pos)]) * (pos - Math.floor(pos));
  return { min: nums[0], max: nums[nums.length - 1], ...(withMid ? { mid } : {}), colors };
}

function withSheetScales(table: ScoringTable): ScoringTable {
  const keys = SCORING_SCALED_COLUMNS[table.key];
  if (!keys) return table;
  return {
    ...table,
    columns: table.columns.map((c, i) =>
      keys.includes(c.key) ? { ...c, scale: colorScale(table.rows.map((r) => r[i]), SCORING_SCALE_COLORS, true) } : c),
  };
}

export function buildScoringTables(input: ScoreRow[]): ScoringTable[] {
  return buildTables(input).map(withSheetScales);
}

function buildTables(input: ScoreRow[]): ScoringTable[] {
  // Input arrives in the writer's rerank_ order: completed niches by decision score, then the rest by decision score.
  const rows = input;

  const nicheSummary: ScoringTable = {
    key: "niche_summary",
    title: "Niche Summary",
    description: "One row per micro-niche, ranked by decision score among completed runs.",
    columns: [
      col("rank", "Rank", "rank"),
      col("subniche", "MicroNiche", "text"),
      col("scoring_status", "Scoring Status", "status"),
      col("l0_gate_status", "L0 Gate Status", "status"),
      col("l0_qualification", "L0 Qualification", "longtext"),
      col("opportunity", "Opportunity Score", "score"),
      col("decision", "Decision Score", "score"),
      col("confidence", "Evidence Confidence Score", "score"),
      col("coverage", "Coverage %", "percent"),
      col("completeness", "Completeness %", "percent"),
      col("overall_justification", "Overall Justification", "longtext"),
      col("recommendation", "Recommendation", "status"),
      col("primary_reason", "Primary Reason", "longtext"),
      col("next_step", "Next Step", "longtext"),
      col("generated_at", "Generated At", "date"),
    ],
    rows: rows.map((r) => {
      const n = r.nicheSummary;
      return [
        r.rank, r.subniche, val(n.scoring_status), val(n.l0_gate_status), val(n.l0_qualification), overallScore(r, n.opportunity_score, "opportunity"),
        overallScore(r, n.decision_score, "decision"), val(n.evidence_confidence), val(n.coverage_pct), val(n.completeness_pct), val(n.overall_justification),
        val(n.recommendation), val(n.primary_reason), val(n.next_step), val(n.generated_at),
      ];
    }),
  };

  const summary: ScoringTable = {
    key: "cross_niche_summary",
    title: "Cross-Niche Summary",
    description: "Confidence-adjusted score (0–100) for every criterion, side by side.",
    columns: [
      ...HEAD_COLUMNS,
      ...SEARCHFUND_CATALOG.flatMap((l) => l.criteria.map(([id, name]) => col(id, `${id} ${name}`, "score", `${l.id} ${l.name}`))),
    ],
    rows: rows.map((r) => {
      const h = r.crossNicheSummary ?? r.nicheSummary;
      const adjusted = isRecord(h.criteria_adjusted) ? h.criteria_adjusted : {};
      return [...head(r, r.nicheSummary), ...SEARCHFUND_CATALOG.flatMap((l) => l.criteria.map(([id]) => val(adjusted[id])))];
    }),
  };

  const comparison: ScoringTable = {
    key: "cross_niche_comparison",
    title: "Cross-Niche Comparison",
    description: "Every layer's weight and scores, and every criterion's raw score, confidence and adjusted score.",
    columns: [
      ...HEAD_COLUMNS,
      ...SEARCHFUND_CATALOG.flatMap((l) => {
        const g = `${l.id} ${l.name}`;
        return [
          col(`${l.id}.weight`, "Weight", "weight", g, "Layer"),
          col(`${l.id}.opportunity`, "Opportunity", "score", g, "Layer"),
          col(`${l.id}.decision`, "Decision", "score", g, "Layer"),
          col(`${l.id}.confidence`, "Confidence", "score", g, "Layer"),
          ...l.criteria.flatMap(([id, name]) => [
            col(`${id}.raw`, "Raw (1-10)", "number", g, `${id} ${name}`),
            col(`${id}.confidence`, "Confidence", "status", g, `${id} ${name}`),
            col(`${id}.adjusted`, "Adjusted (0-100)", "score", g, `${id} ${name}`),
          ]),
        ];
      }),
    ],
    rows: rows.map((r) => {
      const h = r.crossNicheComparison ?? {};
      const layers = isRecord(h.layers) ? h.layers : {};
      const criteria = isRecord(h.criteria) ? h.criteria : {};
      return [
        ...head(r, r.nicheSummary),
        ...SEARCHFUND_CATALOG.flatMap((l) => {
          const L = isRecord(layers[l.id]) ? (layers[l.id] as Json) : {};
          return [
            l.weight, val(L.opportunity), val(L.decision), val(L.confidence),
            ...l.criteria.flatMap(([id]) => {
              const C = isRecord(criteria[id]) ? (criteria[id] as Json) : {};
              return [val(C.raw), val(C.confidence), val(C.adjusted)];
            }),
          ];
        }),
      ];
    }),
  };

  const layerDetail: ScoringTable = {
    key: "layer_detail",
    title: "Layer Detail (L1-L6)",
    description: "Each core layer's weight, scores and justification.",
    columns: [
      col("rank", "Rank", "rank"), col("subniche", "Subniche", "text"), col("layer", "Layer", "status"), col("layer_name", "Layer Name", "text"),
      col("weight", "Outer Weight", "weight"), col("opportunity", "Opportunity Score", "score"), col("decision", "Decision Score", "score"),
      col("confidence", "Evidence Confidence Score", "score"), col("justification", "Layer Justification", "longtext"),
    ],
    rows: rows.flatMap((r) => {
      const fromResult = arr(r.result?.layer_results).filter((l) => /^L[1-6]$/.test(String(l.layer)));
      if (fromResult.length) {
        return fromResult.map((l) => [r.rank, r.subniche, val(l.layer), val(l.name), val(l.weight), val(l.opportunity), val(l.decision), val(l.confidence), val(l.layer_summary)]);
      }
      return detailRows(r, "layers", 7);
    }),
  };

  const criteriaDetail: ScoringTable = {
    key: "criteria_detail",
    title: "Criteria Detail",
    description: "Every criterion: raw score, confidence, penalty, adjusted score, weighted contributions and justification.",
    columns: [
      col("rank", "Rank", "rank"), col("subniche", "Subniche", "text"), col("layer", "Layer", "status"), col("criterion_id", "Criterion ID", "text"),
      col("key", "Key", "text"), col("criterion", "Criterion", "text"), col("local_weight", "Local Weight", "weight"),
      col("raw", "Raw Score (1-10)", "number"), col("gate_status", "Gate Status", "status"), col("confidence", "Confidence", "status"),
      col("coefficient", "Confidence Coefficient", "number"), col("normalized", "Normalized Score (0-100)", "score"),
      col("penalty", "Confidence Penalty", "number"), col("adjusted", "Adjusted Score (0-100)", "score"),
      col("w_opportunity", "Weighted Opportunity Contribution", "number"), col("w_decision", "Weighted Decision Contribution", "number"),
      col("justification", "Justification", "longtext"),
    ],
    rows: rows.flatMap((r) => {
      const fromResult = arr(r.result?.criterion_results).filter((c) => /^L[1-6]$/.test(String(c.layer)));
      if (fromResult.length) {
        return fromResult.map((c) => {
          const w = num(c.local_weight);
          const q = num(c.q);
          const a = num(c.a);
          return [
            r.rank, r.subniche, val(c.layer), val(c.criterion_id), slug(String(c.name ?? "")), val(c.name), w, val(c.score_1_10),
            c.score_1_10 === null || c.score_1_10 === undefined ? "UNKNOWN" : "PASS", val(c.confidence), val(c.coefficient), q,
            val(c.adjustment), a, w !== null && q !== null ? w * q : null, w !== null && a !== null ? w * a : null,
            val(c.scoring_rationale ?? c.finding),
          ];
        });
      }
      return detailRows(r, "criteria", 15);
    }),
  };

  const noncore: ScoringTable = {
    key: "noncore",
    title: "Non-Core Layers (L7-L8)",
    description: "Layers assessed separately from the core score.",
    columns: [
      col("rank", "Rank", "rank"), col("subniche", "Subniche", "text"), col("layer", "Layer", "status"), col("layer_name", "Layer Name", "text"),
      col("weight", "Core Weight", "weight"), col("status", "Status", "status"), col("justification", "Justification", "longtext"),
    ],
    rows: rows.flatMap((r) => {
      const stored = detailRows(r, "noncore", 5);
      if (stored.length) return stored;
      if (!r.result) return [];
      return [
        [r.rank, r.subniche, "L7", "Structural Alpha Overlay", 0, "ASSESSED_SEPARATELY", "Used as a qualitative thesis overlay and intentionally excluded from the core numerical score to prevent double counting."],
        [r.rank, r.subniche, "L8", "Evidence, Confidence, and Integrity Audit", 0, "ASSESSED_SEPARATELY", "Used to calibrate confidence and identify evidence gaps; intentionally excluded from core points because confidence penalties are already applied criterion by criterion."],
      ];
    }),
  };

  const gates: ScoringTable = {
    key: "l0_gates",
    title: "L0 Gates",
    description: "Each eligibility gate's status and rationale.",
    columns: [col("rank", "Rank", "rank"), col("subniche", "Subniche", "text"), col("gate", "Gate", "text"), col("status", "Status", "status"), col("rationale", "Rationale", "longtext")],
    rows: rows.flatMap((r) => arr(r.result?.gates).map((g) => [r.rank, r.subniche, val(g.gate_id), val(g.status), val(g.rationale)])),
  };

  const overlays: ScoringTable = {
    key: "l7_overlays",
    title: "L7 Overlays",
    description: "Structural alpha overlays (tax, ESOP, licensing and similar) per niche.",
    columns: [col("rank", "Rank", "rank"), col("subniche", "Subniche", "text"), col("criterion_id", "Criterion ID", "text"), col("name", "Overlay", "text"), col("status", "Status", "status"), col("confidence", "Confidence", "status"), col("rationale", "Rationale", "longtext")],
    rows: rows.flatMap((r) => arr(r.result?.l7_overlays).map((o) => [r.rank, r.subniche, val(o.criterion_id), val(o.name), val(o.status), val(o.confidence), val(o.rationale)])),
  };

  const audit: ScoringTable = {
    key: "l8_audit",
    title: "L8 Audit",
    description: "Evidence, confidence and integrity audit per niche.",
    columns: [col("rank", "Rank", "rank"), col("subniche", "Subniche", "text"), col("criterion_id", "Criterion ID", "text"), col("name", "Audit Check", "text"), col("signal", "Signal", "status"), col("confidence", "Confidence", "status"), col("finding", "Finding", "longtext")],
    rows: rows.flatMap((r) => arr(r.result?.l8_audit).map((a) => [r.rank, r.subniche, val(a.criterion_id), val(a.name), val(a.signal), val(a.confidence), val(a.finding)])),
  };

  const gaps: ScoringTable = {
    key: "gap_queue",
    title: "Gap Queue",
    description: "Open evidence gaps blocking a firmer score.",
    columns: [col("rank", "Rank", "rank"), col("subniche", "Subniche", "text"), col("owner", "Owner", "status"), col("criterion_id", "Criterion ID", "text"), col("need", "Data Needed", "longtext")],
    rows: rows.flatMap((r) => arr(r.result?.gap_queue).map((g) => [r.rank, r.subniche, val(g.owner), val(g.criterion_id), val(g.need)])),
  };

  return [nicheSummary, summary, comparison, layerDetail, criteriaDetail, noncore, gates, overlays, audit, gaps];
}

/** Rows the writer's `details` action stored, prefixed with rank and subniche like the sheet's detail tabs. */
function detailRows(r: ScoreRow, key: "layers" | "criteria" | "noncore", width: number) {
  const stored = r.details?.[key];
  if (!Array.isArray(stored)) return [];
  return stored
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => [r.rank, r.subniche, ...Array.from({ length: width }, (_, i) => val(row[i]))]);
}
