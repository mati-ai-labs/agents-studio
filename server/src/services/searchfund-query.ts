// Server-side search / column filters / sort / pagination for the SearchFund dashboard tables.
// The Taxonomy_Master niches run in SQL (see searchfund.ts); the scoring tables, built in memory
// from the stored score.py JSON, go through queryRows/facetRows here.
import type { ColumnType, TableColumn } from "./searchfund-tables.js";

type Cell = string | number | null;
export type Facet = { value: string; count: number };
export type TableQuery = {
  page: number;
  pageSize: number;
  q: string;
  sort: string | null;
  dir: "asc" | "desc";
  filters: Record<string, string[]>;
};

export const PAGE_SIZE = 50;
export const FACET_LIMIT = 1000;
export const NUMERIC_RE = /^\s*-?\$?[0-9,]*\.?[0-9]+\s*%?\s*$/;

export function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !NUMERIC_RE.test(v)) return null;
  const n = Number(v.replace(/[,$%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

const one = (v: unknown) => (Array.isArray(v) ? v[0] : v);
const cellText = (v: Cell) => (v === null || v === undefined ? "" : String(v));

/** page, pageSize (≤200), q, sort, dir, filters (JSON: { columnKey: [values] }) from a query string. */
export function parseTableQuery(query: Record<string, unknown>): TableQuery {
  const int = (v: unknown, d: number) => {
    const n = Number.parseInt(String(one(v) ?? ""), 10);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  let filters: Record<string, string[]> = {};
  try {
    const raw = JSON.parse(String(one(query.filters) ?? "{}"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw)) {
        const vals = (Array.isArray(v) ? v : [v]).map((x) => String(x ?? ""));
        if (vals.length) filters[k] = vals.slice(0, 500);
      }
    }
  } catch {
    filters = {};
  }
  const sort = String(one(query.sort) ?? "").trim();
  return {
    page: int(query.page, 1),
    pageSize: Math.min(int(query.pageSize, PAGE_SIZE), 200),
    q: String(one(query.q) ?? "").trim().slice(0, 200),
    sort: sort || null,
    dir: one(query.dir) === "asc" ? "asc" : "desc",
    filters,
  };
}

function matches(columns: TableColumn[], row: Cell[], query: TableQuery, skipKey?: string) {
  for (const [key, vals] of Object.entries(query.filters)) {
    if (key === skipKey || !vals.length) continue;
    const i = columns.findIndex((c) => c.key === key);
    if (i >= 0 && !vals.includes(cellText(row[i]))) return false;
  }
  if (query.q) {
    const q = query.q.toLowerCase();
    if (!row.some((c) => c !== null && String(c).toLowerCase().includes(q))) return false;
  }
  return true;
}

/** One page of rows after search, column filters and sort. With no sort the input order is kept. */
export function queryRows(columns: TableColumn[], rows: Cell[][], query: TableQuery) {
  let out = rows.filter((r) => matches(columns, r, query));
  const i = query.sort ? columns.findIndex((c) => c.key === query.sort) : -1;
  if (i >= 0) {
    const sign = query.dir === "asc" ? 1 : -1;
    out = [...out].sort((a, b) => {
      const x = a[i];
      const y = b[i];
      const bx = x === null || x === "";
      const by = y === null || y === "";
      if (bx || by) return bx === by ? 0 : bx ? 1 : -1;
      const nx = toNumber(x);
      const ny = toNumber(y);
      const cmp = nx !== null && ny !== null ? nx - ny : String(x).localeCompare(String(y), undefined, { numeric: true });
      return cmp * sign;
    });
  }
  const start = (query.page - 1) * query.pageSize;
  return { total: out.length, page: query.page, pageSize: query.pageSize, rows: out.slice(start, start + query.pageSize) };
}

/** Distinct values (with counts) of one column, under every other active filter and the search. */
export function facetRows(columns: TableColumn[], rows: Cell[][], query: TableQuery, key: string): Facet[] {
  const i = columns.findIndex((c) => c.key === key);
  if (i < 0) return [];
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!matches(columns, r, query, key)) continue;
    const v = cellText(r[i]);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return sortFacets([...counts].map(([value, count]) => ({ value, count })), columns[i].type).slice(0, FACET_LIMIT);
}

/** Numbers ascending, everything else alphabetical; blanks last. */
export function sortFacets(facets: Facet[], type: ColumnType) {
  const numeric = type !== "text" && type !== "longtext" && type !== "status";
  return facets.sort((a, b) => {
    if (!a.value || !b.value) return a.value === b.value ? 0 : a.value ? -1 : 1;
    const na = numeric ? toNumber(a.value) : null;
    const nb = numeric ? toNumber(b.value) : null;
    if (na !== null && nb !== null) return na - nb;
    return a.value.localeCompare(b.value, undefined, { numeric: true });
  });
}

/** Column type from per-column value statistics (same rules the sheet tabs use in the UI). */
export function inferColumnType(
  label: string,
  stats: { rows: number; filled: number; distinct: number; avgLength: number; numeric: boolean; max: number | null; allPercent: boolean },
): ColumnType {
  if (/status/i.test(label)) return "status";
  if (!stats.filled) return "text";
  if (stats.numeric) {
    if (/score|confidence|adjusted|opportunity|decision/i.test(label) && stats.max !== null && stats.max <= 100 && stats.max > 10) return "score";
    if (/%/.test(label) || stats.allPercent) return "percent";
    if (/^(#|rank)$/i.test(label.trim())) return "rank";
    return "number";
  }
  if (stats.rows >= 6 && stats.distinct <= 25 && stats.avgLength <= 32) return "status";
  if (stats.avgLength > 70) return "longtext";
  return "text";
}
