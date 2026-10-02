import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Download, Filter, Info, Lock, Play, Search, Telescope, X } from "lucide-react";
import { Link, useNavigate, useParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import {
  searchfundApi,
  type SearchfundColumn,
  type SearchfundColorScale,
  type SearchfundColumnType,
  type SearchfundFacet,
  type SearchfundNicheRow,
  type SearchfundCriterionDoc,
  type SearchfundLayerDoc,
  type SearchfundRun,
  type SearchfundScoringModel,
  type SearchfundTable,
} from "../api/searchfund";

const PAGE_TABS = ["taxonomy", "scoring", "files"] as const;
type PageTab = (typeof PAGE_TABS)[number];
type Value = string | number | null;
const cellText = (v: Value) => (v === null || v === undefined ? "" : String(v));

const searchfundKeys = {
  access: (companyId: string) => ["searchfund", companyId, "access"] as const,
  niches: (companyId: string) => ["searchfund", companyId, "niches"] as const,
  nicheColumns: (companyId: string) => ["searchfund", companyId, "niche-columns"] as const,
  scoringModel: (companyId: string) => ["searchfund", companyId, "scoring-model"] as const,
  scoring: (companyId: string) => ["searchfund", companyId, "scoring"] as const,
  runs: (companyId: string) => ["searchfund", companyId, "runs"] as const,
  workbooks: (companyId: string) => ["searchfund", companyId, "workbooks"] as const,
  sheet: (companyId: string, workbook: string, tab: string) => ["searchfund", companyId, "sheet", workbook, tab] as const,
  layers: (companyId: string, issue: string) => ["searchfund", companyId, "layers", issue] as const,
};

// ---------------------------------------------------------------- formatting

const STATUS_WORDS: Record<string, string> = {
  COMPLETE: "Done",
  PARTIAL: "Done – partial",
  HOLD_GATES: "On hold – gates",
  INELIGIBLE: "Ineligible",
  ASSESSED_SEPARATELY: "Assessed separately",
};

function toNumber(value: Value): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[%,$\s]/g, "");
  if (cleaned === "" || !/^-?\d*\.?\d+$/.test(cleaned)) return null;
  return Number(cleaned);
}

function toneFor(text: string) {
  const t = text.toLowerCase();
  if (/^(pass|complete|done|high|strong|positive|favorable|yes|finished|true|tier 1)/.test(t)) return "green";
  if (/(fail|ineligible|blocked|negative|unfavorable|^low|weak|trap|^no$|error|red flag)/.test(t)) return "red";
  if (/(hold|unknown|partial|medium|moderate|mixed|in progress|review|potential|pending|tier 2|conditional|caution)/.test(t)) return "amber";
  return "gray";
}

const TONE_CLASS: Record<string, string> = {
  green: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  amber: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  red: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
  gray: "border-border bg-muted/50 text-foreground/80",
};

function StatusBadge({ value }: { value: string }) {
  const label = STATUS_WORDS[value] ?? value;
  return (
    <span className={cn("inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium", TONE_CLASS[toneFor(label)])}>
      {label}
    </span>
  );
}

function scoreTone(n: number) {
  if (n >= 70) return "bg-emerald-500";
  if (n >= 55) return "bg-lime-500";
  if (n >= 40) return "bg-amber-500";
  return "bg-red-500";
}

function ScoreCell({ value }: { value: number }) {
  return (
    <div className="flex min-w-[96px] items-center gap-2">
      <span className="w-9 text-right font-medium tabular-nums">{value.toFixed(1)}</span>
      <div className="h-1.5 flex-1 rounded-full bg-muted">
        <div className={cn("h-1.5 rounded-full", scoreTone(value))} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}

function LongText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 140;
  return (
    <div
      className={cn("whitespace-pre-wrap break-words leading-snug", long && "cursor-pointer", long && !open && "line-clamp-3")}
      onClick={long ? () => setOpen((v) => !v) : undefined}
      title={long && !open ? "Click to expand" : undefined}
    >
      {text}
    </div>
  );
}

function fmtDate(value: string) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function CellValue({ type, value }: { type: SearchfundColumnType; value: Value }) {
  if (value === null || value === "") return <span className="text-muted-foreground/50">—</span>;
  const text = String(value);
  if (/^https?:\/\/\S+$/.test(text.trim())) {
    return <a href={text.trim()} target="_blank" rel="noreferrer" className="break-all text-primary underline">{text}</a>;
  }
  const n = toNumber(value);
  switch (type) {
    case "rank":
      return <span className="font-semibold tabular-nums">{n !== null && n > 0 ? `#${n}` : "—"}</span>;
    case "score":
      return n === null ? <StatusBadge value={text} /> : <ScoreCell value={n} />;
    case "percent":
      return <span className="tabular-nums">{n === null ? text : `${n.toFixed(n % 1 ? 1 : 0)}%`}</span>;
    case "weight":
      return <span className="tabular-nums">{n === null ? text : n <= 1 ? `${Math.round(n * 100)}%` : text}</span>;
    case "number":
      return <span className="tabular-nums">{n === null ? text : Number.isInteger(n) ? n.toLocaleString() : n.toFixed(2)}</span>;
    case "status":
      return <StatusBadge value={text} />;
    case "date":
      return <span className="whitespace-nowrap">{fmtDate(text)}</span>;
    case "longtext":
      return <LongText text={text} />;
    default:
      return <span className="whitespace-pre-wrap break-words">{text}</span>;
  }
}

// ---------------------------------------------------------------- sheet colours (conditional formatting)

const hexRgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
const mix = (a: string, b: string, t: number) => {
  const [x, y] = [hexRgb(a), hexRgb(b)];
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(",")})`;
};

/** Google Sheets colour scale: linear between min → (mid) → max, clamped. */
function scaleColor(scale: SearchfundColorScale, n: number) {
  const { min, mid, max, colors } = scale;
  if (max <= min) return colors[colors.length - 1];
  if (mid !== undefined && colors.length === 3) {
    if (n <= mid) return mix(colors[0], colors[1], mid > min ? Math.max(0, (n - min) / (mid - min)) : 1);
    return mix(colors[1], colors[2], max > mid ? Math.min(1, (n - mid) / (max - mid)) : 1);
  }
  return mix(colors[0], colors[colors.length - 1], Math.min(1, Math.max(0, (n - min) / (max - min))));
}

function cellColors(column: SearchfundColumn, value: Value): CSSProperties | undefined {
  if (column.highlight) {
    const h = column.highlight[cellText(value).trim()];
    if (h) return { backgroundColor: h.bg, color: h.fg };
  }
  if (column.scale) {
    const n = toNumber(value);
    if (n !== null) return { backgroundColor: scaleColor(column.scale, n), color: "#111827" };
  }
  return undefined;
}

const RIGHT_ALIGNED: SearchfundColumnType[] = ["number", "percent", "weight", "rank"];
const COL_WIDTH: Record<SearchfundColumnType, string> = {
  rank: "min-w-[56px]",
  text: "min-w-[140px] max-w-[260px]",
  longtext: "min-w-[280px] max-w-[420px]",
  score: "min-w-[130px]",
  number: "min-w-[80px]",
  percent: "min-w-[80px]",
  weight: "min-w-[72px]",
  status: "min-w-[110px]",
  date: "min-w-[150px]",
};

// ---------------------------------------------------------------- data table
// Search, per-column filters, sort and 50-row pages. Big tables (Taxonomy_Master, scoring tables) run all of it
// on the server; small ones (sheet reference tabs, a run's layer data) use the same logic locally.

type Leading = { header: string; render: (row: Value[], meta: unknown) => ReactNode };
type TableState = { page: number; q: string; sort: string | null; dir: "asc" | "desc"; filters: Record<string, string[]> };
type TablePage = { total: number; page: number; pageSize: number; rows: Value[][]; meta?: unknown[] };
type TableSource = {
  id: readonly unknown[];
  fetchPage: (s: TableState) => Promise<TablePage>;
  fetchFacets: (column: string, s: TableState) => Promise<SearchfundFacet[]>;
  refetchInterval?: number;
};

const PAGE_SIZE = 50;
const EMPTY_STATE: TableState = { page: 1, q: "", sort: null, dir: "desc", filters: {} };

export function tableParams(s: TableState, extra: Record<string, string> = {}) {
  const p = new URLSearchParams({ page: String(s.page), pageSize: String(PAGE_SIZE), q: s.q, dir: s.dir, ...extra });
  if (s.sort) p.set("sort", s.sort);
  const active = Object.fromEntries(Object.entries(s.filters).filter(([, v]) => v.length));
  if (Object.keys(active).length) p.set("filters", JSON.stringify(active));
  return p.toString();
}

function localMatch(columns: SearchfundColumn[], row: Value[], s: TableState, skip?: string) {
  for (const [key, vals] of Object.entries(s.filters)) {
    if (key === skip || !vals.length) continue;
    const i = columns.findIndex((c) => c.key === key);
    if (i >= 0 && !vals.includes(cellText(row[i]))) return false;
  }
  const q = s.q.toLowerCase();
  return !q || row.some((c) => c !== null && String(c).toLowerCase().includes(q));
}

function localSource(id: readonly unknown[], columns: SearchfundColumn[], rows: Value[][]): TableSource {
  return {
    id,
    fetchPage: async (s) => {
      let out = rows.filter((r) => localMatch(columns, r, s));
      const i = s.sort ? columns.findIndex((c) => c.key === s.sort) : -1;
      if (i >= 0) {
        const sign = s.dir === "asc" ? 1 : -1;
        out = [...out].sort((a, b) => {
          const bx = cellText(a[i]) === "";
          const by = cellText(b[i]) === "";
          if (bx || by) return bx === by ? 0 : bx ? 1 : -1;
          const nx = toNumber(a[i]);
          const ny = toNumber(b[i]);
          return sign * (nx !== null && ny !== null ? nx - ny : String(a[i]).localeCompare(String(b[i]), undefined, { numeric: true }));
        });
      }
      const start = (s.page - 1) * PAGE_SIZE;
      return { total: out.length, page: s.page, pageSize: PAGE_SIZE, rows: out.slice(start, start + PAGE_SIZE) };
    },
    fetchFacets: async (column, s) => {
      const i = columns.findIndex((c) => c.key === column);
      const counts = new Map<string, number>();
      for (const r of rows) if (localMatch(columns, r, s, column)) counts.set(cellText(r[i]), (counts.get(cellText(r[i])) ?? 0) + 1);
      return [...counts]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => (!a.value || !b.value ? (a.value ? -1 : 1) : a.value.localeCompare(b.value, undefined, { numeric: true })));
    },
  };
}

/** Header bands: contiguous columns sharing a group (and subgroup) render as one spanning cell. */
function bands(columns: SearchfundColumn[], pick: (c: SearchfundColumn) => string | undefined) {
  const out: Array<{ label: string; span: number }> = [];
  let prev: string | undefined;
  columns.forEach((c, i) => {
    const label = pick(c) ?? "";
    const key = `${c.group ?? ""}|${label}`;
    if (i > 0 && key === prev) out[out.length - 1].span += 1;
    else out.push({ label, span: 1 });
    prev = key;
  });
  return out;
}

/** Excel-style filter for one column: its values (with counts) come from the source, under the other filters. */
function ColumnFilter({
  source,
  column,
  state,
  selected,
  onChange,
}: {
  source: TableSource;
  column: SearchfundColumn;
  state: TableState;
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState("");
  const others = { ...state, page: 1, filters: Object.fromEntries(Object.entries(state.filters).filter(([k]) => k !== column.key)) };
  const { data: facets, isFetching } = useQuery({
    queryKey: [...source.id, "facets", column.key, others.q, others.filters],
    queryFn: () => source.fetchFacets(column.key, others),
    enabled: open,
    staleTime: 15_000,
  });
  const shown = useMemo(() => {
    const f = find.trim().toLowerCase();
    return (facets ?? []).filter((x) => !f || x.value.toLowerCase().includes(f)).slice(0, 300);
  }, [facets, find]);
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          onClick={(e) => e.stopPropagation()}
          className={cn("rounded p-0.5 hover:bg-background", selected.length ? "text-primary" : "text-muted-foreground/60")}
          title={selected.length ? `${selected.length} selected` : "Filter"}
        >
          <Filter className="h-3 w-3" fill={selected.length ? "currentColor" : "none"} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 truncate text-xs font-semibold">{column.label}</div>
        {facets ? (
          <div className="mb-1 text-[11px] text-muted-foreground">
            {facets.length.toLocaleString()} values across {facets.reduce((n, f) => n + f.count, 0).toLocaleString()} rows
            {others.q || Object.values(others.filters).some((v) => v.length) ? " (within your other filters)" : " (all rows)"}
          </div>
        ) : null}
        <Input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a value" className="mb-1 h-8 text-xs" />
        <div className="max-h-64 overflow-auto">
          {!facets && isFetching ? <div className="px-1 py-2 text-xs text-muted-foreground">Loading…</div> : null}
          {shown.map((f) => (
            <label key={f.value} className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 text-xs hover:bg-accent">
              <input type="checkbox" className="mt-0.5" checked={selected.includes(f.value)} onChange={() => toggle(f.value)} />
              <span className="line-clamp-2 flex-1 break-words">{f.value ? STATUS_WORDS[f.value] ?? f.value : <em className="text-muted-foreground">(blank)</em>}</span>
              <span className="tabular-nums text-muted-foreground">{f.count}</span>
            </label>
          ))}
          {facets && !shown.length ? <div className="px-1 py-2 text-xs text-muted-foreground">No values.</div> : null}
        </div>
        <div className="mt-1 flex justify-between border-t border-border pt-1">
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onChange(shown.map((f) => f.value))}>Select shown</Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={!selected.length} onClick={() => onChange([])}>Clear</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function QueryTable({
  columns,
  source,
  leading,
  stickyKey,
  cellExtra,
}: {
  columns: SearchfundColumn[];
  source: TableSource;
  leading?: Leading | null;
  stickyKey?: string;
  /** Extra content shown under a cell (e.g. the run's task under Run Status). */
  cellExtra?: (column: SearchfundColumn, meta: unknown) => ReactNode;
}) {
  const [state, setState] = useState<TableState>(EMPTY_STATE);
  const [search, setSearch] = useState("");
  // Search waits for a pause in typing, so each keystroke doesn't hit the server.
  useEffect(() => {
    const t = setTimeout(() => setState((s) => (s.q === search.trim() ? s : { ...s, q: search.trim(), page: 1 })), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isFetching, isLoading } = useQuery({
    queryKey: [...source.id, "page", state],
    queryFn: () => source.fetchPage(state),
    placeholderData: keepPreviousData,
    refetchInterval: source.refetchInterval,
  });

  const hasGroups = columns.some((c) => c.group);
  const hasSubgroups = columns.some((c) => c.subgroup);
  const stickyIndex = stickyKey ? columns.findIndex((c) => c.key === stickyKey) : -1;
  const activeFilters = Object.values(state.filters).filter((v) => v.length).length;
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total ? (state.page - 1) * PAGE_SIZE + 1 : 0;
  const to = Math.min(total, state.page * PAGE_SIZE);

  const toggleSort = (c: SearchfundColumn) =>
    setState((s) => {
      if (s.sort !== c.key) return { ...s, page: 1, sort: c.key, dir: c.type === "text" || c.type === "rank" ? "asc" : "desc" };
      const first = c.type === "text" || c.type === "rank" ? "asc" : "desc";
      return s.dir === first ? { ...s, page: 1, dir: first === "asc" ? "desc" : "asc" } : { ...s, page: 1, sort: null };
    });
  const setFilter = (key: string, values: string[]) => setState((s) => ({ ...s, page: 1, filters: { ...s.filters, [key]: values } }));
  const goTo = (page: number) => setState((s) => ({ ...s, page: Math.min(Math.max(1, page), pages) }));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search all columns" className="h-9 pl-8" />
        </div>
        {Object.entries(state.filters)
          .filter(([, v]) => v.length)
          .map(([key, values]) => (
            <span key={key} className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/5 px-2 py-0.5 text-[11px]">
              <span className="max-w-[160px] truncate font-medium">{columns.find((c) => c.key === key)?.label ?? key}</span>
              <span className="max-w-[160px] truncate text-muted-foreground">: {values.length === 1 ? values[0] || "(blank)" : `${values.length} values`}</span>
              <button onClick={() => setFilter(key, [])} className="text-muted-foreground hover:text-foreground"><X className="h-3 w-3" /></button>
            </span>
          ))}
        {activeFilters || state.q || search ? (
          <Button variant="ghost" size="sm" className="h-8" onClick={() => { setSearch(""); setState(EMPTY_STATE); }}>
            <X className="mr-1 h-3.5 w-3.5" /> Clear all
          </Button>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground">
          {isFetching ? "Loading… · " : ""}{total.toLocaleString()} rows · {columns.length} columns
        </span>
      </div>
      <div className={cn("max-h-[72vh] overflow-auto rounded-lg border border-border bg-card transition-opacity", isFetching && !isLoading && "opacity-70")}>
        <table className="w-max min-w-full border-collapse text-xs">
          <thead className="sticky top-0 z-20">
            {hasGroups ? (
              <tr className="bg-muted">
                {leading ? <th className="sticky left-0 z-30 bg-muted" /> : null}
                {bands(columns, (c) => c.group).map((b, i) => (
                  <th key={i} colSpan={b.span} className="border-b border-r border-border px-2 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {b.label}
                  </th>
                ))}
              </tr>
            ) : null}
            {hasSubgroups ? (
              <tr className="bg-muted">
                {leading ? <th className="sticky left-0 z-30 bg-muted" /> : null}
                {bands(columns, (c) => c.subgroup).map((b, i) => (
                  <th key={i} colSpan={b.span} className="border-b border-r border-border px-2 py-1 text-left text-[11px] font-medium text-muted-foreground">
                    {b.label}
                  </th>
                ))}
              </tr>
            ) : null}
            <tr className="bg-muted">
              {leading ? (
                <th className="sticky left-0 z-30 min-w-[104px] border-b border-r border-border bg-muted px-2 py-2 text-left font-semibold">{leading.header}</th>
              ) : null}
              {columns.map((c, i) => (
                <th
                  key={c.key + i}
                  onClick={() => toggleSort(c)}
                  className={cn(
                    "cursor-pointer select-none border-b border-r border-border bg-muted px-2 py-2 text-left align-bottom font-semibold hover:bg-accent",
                    COL_WIDTH[c.type],
                    RIGHT_ALIGNED.includes(c.type) && "text-right",
                    i === stickyIndex && "sticky z-30",
                  )}
                  style={i === stickyIndex ? { left: leading ? 104 : 0 } : undefined}
                  title={c.note}
                >
                  <span className="inline-flex items-center gap-1">
                    {c.label}
                    {c.note ? <Info className="h-3 w-3 text-muted-foreground" /> : null}
                    {state.sort === c.key ? state.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" /> : null}
                    <ColumnFilter source={source} column={c} state={state} selected={state.filters[c.key] ?? []} onChange={(v) => setFilter(c.key, v)} />
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(data?.rows ?? []).map((r, ri) => (
              <tr key={ri} className="border-b border-border/60 hover:bg-accent/30">
                {leading ? (
                  <td className="sticky left-0 z-10 min-w-[104px] border-r border-border bg-card px-2 py-1.5 align-top">{leading.render(r, data?.meta?.[ri])}</td>
                ) : null}
                {columns.map((c, ci) => {
                  const colors = cellColors(c, r[ci] ?? null);
                  return (
                    <td
                      key={ci}
                      className={cn(
                        "border-r border-border/60 px-2 py-1.5 align-top",
                        COL_WIDTH[c.type],
                        RIGHT_ALIGNED.includes(c.type) && "text-right",
                        ci === stickyIndex && "sticky z-10 bg-card font-medium",
                      )}
                      style={{ ...(ci === stickyIndex ? { left: leading ? 104 : 0 } : {}), ...colors }}
                    >
                      {colors && c.scale ? (
                        <span className="font-medium tabular-nums">{toNumber(r[ci] ?? null)?.toFixed(c.type === "score" ? 1 : 2)}</span>
                      ) : colors ? (
                        <span className="font-semibold">{cellText(r[ci] ?? null)}</span>
                      ) : (
                        <CellValue type={c.type} value={r[ci] ?? null} />
                      )}
                      {cellExtra?.(c, data?.meta?.[ri])}
                    </td>
                  );
                })}
              </tr>
            ))}
            {data && !data.rows.length ? (
              <tr>
                <td colSpan={columns.length + (leading ? 1 : 0)} className="px-3 py-6 text-center text-muted-foreground">
                  No rows match.
                </td>
              </tr>
            ) : null}
            {isLoading ? (
              <tr>
                <td colSpan={columns.length + (leading ? 1 : 0)} className="px-3 py-6 text-center text-muted-foreground">Loading…</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
        <span>{from}–{to} of {total.toLocaleString()}</span>
        <Button variant="outline" size="sm" className="h-7 px-2" disabled={state.page <= 1} onClick={() => goTo(1)}><ChevronsLeft className="h-3.5 w-3.5" /></Button>
        <Button variant="outline" size="sm" className="h-7 px-2" disabled={state.page <= 1} onClick={() => goTo(state.page - 1)}><ChevronLeft className="h-3.5 w-3.5" /></Button>
        <span className="tabular-nums">Page {state.page} of {pages}</span>
        <Button variant="outline" size="sm" className="h-7 px-2" disabled={state.page >= pages} onClick={() => goTo(state.page + 1)}><ChevronRight className="h-3.5 w-3.5" /></Button>
        <Button variant="outline" size="sm" className="h-7 px-2" disabled={state.page >= pages} onClick={() => goTo(pages)}><ChevronsRight className="h-3.5 w-3.5" /></Button>
      </div>
    </div>
  );
}

/** A table whose rows are already in the browser (small tables), with the same search/filters/sort/pages. */
let localTableSeq = 0;
function DataTable({ columns, rows, leading, stickyKey }: { columns: SearchfundColumn[]; rows: Value[][]; leading?: Leading | null; stickyKey?: string }) {
  const source = useMemo(() => localSource(["searchfund-local", ++localTableSeq], columns, rows), [columns, rows]);
  return <QueryTable columns={columns} source={source} leading={leading} stickyKey={stickyKey} />;
}

// ---------------------------------------------------------------- sheet tabs (reference tabs synced from the workbooks)

const isBlank = (cell: unknown) => String(cell ?? "").trim() === "";
const filledCount = (row: string[]) => row.filter((c) => !isBlank(c)).length;

/** Column types for a sheet tab, read from its values: numbers, 0–100 scores, short categories (filterable), long text. */
export function inferColumns(header: string[], body: string[][]): SearchfundColumn[] {
  return header.map((label, i) => {
    const values = body.map((r) => String(r[i] ?? "").trim()).filter(Boolean);
    const key = `c${i}`;
    if (!values.length) return { key, label, type: "text" };
    const nums = values.map((v) => toNumber(v));
    if (nums.every((n) => n !== null)) {
      const max = Math.max(...(nums as number[]));
      if (/score|confidence|adjusted|opportunity|decision/i.test(label) && max <= 100 && max > 10) return { key, label, type: "score" };
      if (/%/.test(label) || values.every((v) => v.endsWith("%"))) return { key, label, type: "percent" };
      if (/^(#|rank)$/i.test(label.trim())) return { key, label, type: "rank" };
      return { key, label, type: "number" };
    }
    const distinct = new Set(values).size;
    const avg = values.reduce((s, v) => s + v.length, 0) / values.length;
    if (body.length >= 6 && distinct <= 25 && avg <= 32) return { key, label, type: "status" };
    if (avg > 70) return { key, label, type: "longtext" };
    return { key, label, type: "text" };
  });
}

function parseSheet(rows: string[][]) {
  const width = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const scan = Math.min(rows.length, 12);
  let h = rows.slice(0, scan).findIndex((r) => filledCount(r) >= Math.max(2, Math.ceil(width * 0.5)));
  if (h < 0) h = rows.slice(0, scan).findIndex((r) => filledCount(r) >= 2);
  if (h < 0) h = 0;
  const titles = rows
    .slice(0, h)
    .filter((r) => filledCount(r) >= 1)
    .map((r) => r.filter((c) => !isBlank(c)).join(" · "))
    .filter((t) => !/^\d+$/.test(t.trim())); // stray counter cells above the table
  const header = Array.from({ length: width }, (_, i) => rows[h]?.[i] || `Column ${i + 1}`);
  const body = rows.slice(h + 1).filter((r) => filledCount(r) > 0);
  const keep = header.map((_, i) => !isBlank(rows[h]?.[i]) || body.some((r) => !isBlank(r[i])));
  return {
    titles,
    header: header.filter((_, i) => keep[i]),
    body: body.map((r) => header.map((_, i) => r[i] ?? "").filter((_, i) => keep[i])),
  };
}

function SheetTab({ companyId, workbook, tab, leading }: { companyId: string; workbook: string; tab: string; leading?: Leading | null }) {
  const { data: sheet, isLoading } = useQuery({
    queryKey: searchfundKeys.sheet(companyId, workbook, tab),
    queryFn: () => searchfundApi.sheet(companyId, workbook, tab),
  });
  const parsed = useMemo(() => (sheet ? parseSheet(sheet.rows) : null), [sheet]);
  const columns = useMemo(() => (parsed ? inferColumns(parsed.header, parsed.body) : []), [parsed]);
  if (isLoading || !parsed) return <PageSkeleton variant="list" />;
  return (
    <div className="space-y-2">
      {parsed.titles.length ? (
        <div className="space-y-0.5">
          {parsed.titles.map((t, i) => (
            <div key={i} className={cn(i === 0 ? "text-sm font-semibold" : "text-xs text-muted-foreground")}>{t}</div>
          ))}
        </div>
      ) : null}
      <DataTable key={tab} columns={columns} rows={parsed.body} leading={leading} stickyKey={columns.length > 8 ? columns[1]?.key : undefined} />
      <div className="text-[11px] text-muted-foreground">Synced {sheet ? fmtDate(sheet.syncedAt) : ""}</div>
    </div>
  );
}

function SubTabs({ items, value, onChange }: { items: Array<{ key: string; label: string; count?: number }>; value: string; onChange: (key: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={cn(
            "rounded-md border px-2.5 py-1 text-xs",
            t.key === value ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:bg-accent",
          )}
        >
          {t.label}
          {t.count !== undefined ? <span className="ml-1 opacity-70">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn("text-xl font-semibold tabular-nums", tone)}>{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------- Scoring Model (editable weights behind the Composite Score)

type DimensionDraft = { dimension: string; weight: string; derivation: string; score1: string; score5: string; scoreColumn: string | null };

const pct = (w: number) => String(Math.round(w * 10000) / 100);

function ScoringModelTab({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const { data: model, isLoading } = useQuery({
    queryKey: searchfundKeys.scoringModel(companyId),
    queryFn: () => searchfundApi.scoringModel(companyId),
  });
  const [draft, setDraft] = useState<DimensionDraft[] | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    if (model) setDraft(model.dimensions.map((d) => ({ ...d, weight: pct(d.weight) })));
  }, [model]);

  const done = (result: SearchfundScoringModel, title: string) => {
    queryClient.setQueryData(searchfundKeys.scoringModel(companyId), result);
    queryClient.invalidateQueries({ queryKey: searchfundKeys.niches(companyId) });
    queryClient.invalidateQueries({ queryKey: searchfundKeys.nicheColumns(companyId) });
    pushToast({ title, body: `Composite Score updated for ${result.updatedNiches ?? 0} micro-niches.`, tone: "success" });
  };
  const save = useMutation({
    mutationFn: (rows: DimensionDraft[]) =>
      searchfundApi.saveScoringModel(
        companyId,
        rows.map(({ dimension, weight, derivation, score1, score5 }) => ({ dimension, weight: Number(weight) / 100, derivation, score1, score5 })),
      ),
    onSuccess: (r) => done(r, "Scoring model saved"),
    onError: (err) => pushToast({ title: "Could not save the scoring model", body: err instanceof Error ? err.message : String(err), tone: "error" }),
  });
  const reset = useMutation({
    mutationFn: () => searchfundApi.resetScoringModel(companyId),
    onSuccess: (r) => done(r, "Back to the Google sheet's weights"),
    onError: (err) => pushToast({ title: "Could not reset", body: err instanceof Error ? err.message : String(err), tone: "error" }),
    onSettled: () => setConfirmReset(false),
  });

  if (isLoading || !draft || !model) return <PageSkeleton variant="list" />;
  if (!model.dimensions.length) return <EmptyState icon={Telescope} message="The Scoring_Model tab hasn't been synced yet." />;

  const weights = draft.map((d) => Number(d.weight));
  const invalid = weights.some((w) => !Number.isFinite(w) || w < 0 || w > 100) || draft.some((d) => !d.dimension.trim());
  const total = weights.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const dirty = draft.some((d, i) => {
    const o = model.dimensions[i];
    return Number(d.weight) !== Number(pct(o.weight)) || d.dimension !== o.dimension || d.derivation !== o.derivation || d.score1 !== o.score1 || d.score5 !== o.score5;
  });
  const set = (i: number, patch: Partial<DimensionDraft>) => setDraft((rows) => rows!.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const field = "w-full rounded-md border border-transparent bg-transparent px-1.5 py-1 text-xs hover:border-border focus:border-primary focus:bg-background focus:outline-none";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <div className="space-y-1 text-xs text-muted-foreground">
          <div className="text-sm font-semibold text-foreground">How the Composite Score (0-5) is calculated</div>
          <div>Each micro-niche is scored 1–5 on every dimension below. Its Composite Score is the sum of each score × that dimension's weight.</div>
          <div>Edit any weight or description and save. Every micro-niche's Composite Score is recalculated straight away.</div>
          <div>
            {model.source === "studio" ? (
              <>Using weights edited in Agent Studio{model.updatedAt ? ` · saved ${fmtDate(model.updatedAt)}` : ""}. The Google sheet is not changed.</>
            ) : (
              <>Using the weights from the Google sheet.</>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {model.source === "studio" ? (
            <Button variant="outline" size="sm" onClick={() => setConfirmReset(true)} disabled={reset.isPending}>Reset to sheet weights</Button>
          ) : null}
          <Button variant="outline" size="sm" disabled={!dirty || save.isPending} onClick={() => setDraft(model.dimensions.map((d) => ({ ...d, weight: pct(d.weight) })))}>
            Discard
          </Button>
          <Button size="sm" disabled={!dirty || invalid || save.isPending} onClick={() => save.mutate(draft)}>
            {save.isPending ? "Saving…" : "Save & recalculate"}
          </Button>
        </div>
      </div>

      <div className="overflow-auto rounded-lg border border-border bg-card">
        <table className="w-full min-w-[960px] border-collapse text-xs">
          <thead className="bg-muted">
            <tr className="text-left">
              <th className="w-10 border-b border-r border-border px-2 py-2 font-semibold">#</th>
              <th className="w-56 border-b border-r border-border px-2 py-2 font-semibold">Dimension</th>
              <th className="w-28 border-b border-r border-border px-2 py-2 text-right font-semibold">Weight</th>
              <th className="w-44 border-b border-r border-border px-2 py-2 font-semibold">Taxonomy column scored</th>
              <th className="w-56 border-b border-r border-border px-2 py-2 font-semibold">How the score is set</th>
              <th className="border-b border-r border-border px-2 py-2 font-semibold">What a score of 1 means (worst)</th>
              <th className="border-b border-border px-2 py-2 font-semibold">What a score of 5 means (best)</th>
            </tr>
          </thead>
          <tbody>
            {draft.map((d, i) => {
              const w = Number(d.weight);
              const changed = Number.isFinite(w) && w !== Number(pct(model.dimensions[i].weight));
              return (
                <tr key={i} className="border-b border-border/60 align-top">
                  <td className="border-r border-border/60 px-2 py-1.5 tabular-nums text-muted-foreground">{i + 1}</td>
                  <td className="border-r border-border/60 px-1 py-1"><input className={cn(field, "font-medium")} value={d.dimension} onChange={(e) => set(i, { dimension: e.target.value })} /></td>
                  <td className="border-r border-border/60 px-1 py-1">
                    <div className="flex items-center justify-end gap-1">
                      <input
                        type="number" min={0} max={100} step={0.5}
                        className={cn(field, "w-16 text-right tabular-nums", changed && "border-primary bg-primary/5", (!Number.isFinite(w) || w < 0 || w > 100) && "border-red-500")}
                        value={d.weight}
                        onChange={(e) => set(i, { weight: e.target.value })}
                      />
                      <span className="text-muted-foreground">%</span>
                    </div>
                    <div className="mt-1 h-1 rounded bg-muted"><div className="h-1 rounded bg-primary" style={{ width: `${Math.min(100, Math.max(0, w || 0) * 4)}%` }} /></div>
                  </td>
                  <td className="border-r border-border/60 px-2 py-1.5 text-muted-foreground">{d.scoreColumn ?? "—"}</td>
                  <td className="border-r border-border/60 px-1 py-1"><textarea rows={2} className={cn(field, "resize-none")} value={d.derivation} onChange={(e) => set(i, { derivation: e.target.value })} /></td>
                  <td className="border-r border-border/60 px-1 py-1"><textarea rows={2} className={cn(field, "resize-none")} value={d.score1} onChange={(e) => set(i, { score1: e.target.value })} /></td>
                  <td className="px-1 py-1"><textarea rows={2} className={cn(field, "resize-none")} value={d.score5} onChange={(e) => set(i, { score5: e.target.value })} /></td>
                </tr>
              );
            })}
            <tr className="bg-muted/40 font-semibold">
              <td className="border-r border-border/60 px-2 py-2" />
              <td className="border-r border-border/60 px-2 py-2">Total</td>
              <td className={cn("border-r border-border/60 px-2 py-2 text-right tabular-nums", Math.abs(total - 100) > 0.001 ? "text-red-600" : "text-emerald-600")}>
                {Math.round(total * 100) / 100}%
              </td>
              <td colSpan={4} className="px-2 py-2 font-normal text-muted-foreground">
                {Math.abs(total - 100) > 0.001
                  ? `Weights add up to ${Math.round(total * 100) / 100}%, not 100%. Composite Scores will no longer be on the 0-5 scale.`
                  : "Weights add up to 100%."}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {model.notes.length ? (
        <div className="rounded-lg border border-border bg-card px-4 py-3 text-xs">
          <div className="mb-1 text-sm font-semibold">Priority tiers & overrides</div>
          <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
            {model.notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        </div>
      ) : null}

      <Dialog open={confirmReset} onOpenChange={(open) => !open && setConfirmReset(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset to the sheet's weights?</DialogTitle>
            <DialogDescription>Your Agent Studio edits are discarded and every Composite Score is recalculated from the Google sheet's Scoring_Model.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmReset(false)}>Cancel</Button>
            <Button disabled={reset.isPending} onClick={() => reset.mutate()}>{reset.isPending ? "Resetting…" : "Reset"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------- Taxonomy Dashboard

function TaxonomyTab({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [confirm, setConfirm] = useState<SearchfundNicheRow | null>(null);
  const [tab, setTab] = useState("Taxonomy_Master");
  const { data: workbooks } = useQuery({ queryKey: searchfundKeys.workbooks(companyId), queryFn: () => searchfundApi.workbooks(companyId) });
  const { data: meta, isLoading } = useQuery({
    queryKey: searchfundKeys.nicheColumns(companyId),
    queryFn: () => searchfundApi.nicheColumns(companyId),
    refetchInterval: 60_000,
  });
  const run = useMutation({
    mutationFn: (niche: SearchfundNicheRow) =>
      searchfundApi.runNiche(companyId, niche.id, `searchfund-${niche.taxonomyId}-${crypto.randomUUID()}`),
    onSuccess: (r, niche) => {
      pushToast({ title: `Research started for ${niche.shortName}`, body: r.issueIdentifier ? `Task ${r.issueIdentifier}` : undefined, tone: "success" });
      queryClient.invalidateQueries({ queryKey: searchfundKeys.niches(companyId) });
    },
    onError: (err, niche) =>
      pushToast({ title: `Could not start ${niche.shortName}`, body: err instanceof Error ? err.message : String(err), tone: "error" }),
    onSettled: () => setConfirm(null),
  });

  // Taxonomy_Master is searched, filtered, sorted and paged by the server (one JSON row per niche, every column kept).
  const columns = meta?.columns ?? [];
  const source = useMemo<TableSource>(
    () => ({
      id: searchfundKeys.niches(companyId),
      refetchInterval: 30_000,
      fetchPage: async (s) => {
        const page = await searchfundApi.nichePage(companyId, tableParams(s));
        return { ...page, rows: page.rows.map((n) => columns.map((c) => n.row[c.key] ?? "")), meta: page.rows };
      },
      fetchFacets: (column, s) => searchfundApi.nicheFacets(companyId, tableParams(s, { column })),
    }),
    [companyId, columns],
  );
  const stats = meta?.stats ?? { total: 0, finished: 0, running: 0, notStarted: 0 };

  const leading: Leading = {
    header: "Run",
    render: (_row, m) => {
      const niche = m as SearchfundNicheRow | undefined;
      if (!niche) return null;
      const issue = niche.linkedIssue;
      return (
        <div className="space-y-1">
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setConfirm(niche)}>
            <Play className="mr-1 h-3 w-3" />
            {issue ? "Re-run" : "Qualify"}
          </Button>
        </div>
      );
    },
  };

  // The run's task (returned when Qualify fires the routine) sits under the row's Run Status.
  const cellExtra = (column: SearchfundColumn, m: unknown) => {
    const issue = column.key === "Run Status" ? (m as SearchfundNicheRow | undefined)?.linkedIssue : null;
    if (!issue?.identifier) return null;
    return (
      <Link to={`/issues/${issue.identifier}`} className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-primary underline">
        {issue.identifier}
        {issue.status ? <span className="text-muted-foreground no-underline">· {issue.status.replace(/_/g, " ")}</span> : null}
      </Link>
    );
  };

  const tabs = workbooks?.find((w) => w.workbook === "dashboard")?.tabs ?? [];
  if (isLoading) return <PageSkeleton variant="list" />;


  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="Micro-niches" value={stats.total} />
        <Stat label="Finished" value={stats.finished} tone="text-emerald-600" />
        <Stat label="In progress" value={stats.running} tone="text-blue-600" />
        <Stat label="Not started" value={stats.notStarted} tone="text-muted-foreground" />
      </div>
      <SubTabs
        items={(tabs.length ? tabs.map((t) => t.tab) : ["Taxonomy_Master"]).map((t) => ({ key: t, label: t.replace(/_/g, " ") }))}
        value={tab}
        onChange={setTab}
      />
      {tab === "Taxonomy_Master" ? (
        columns.length ? (
          <>
            {columns.find((c) => c.key === "Composite Score (0-5)")?.note ? (
              <div className="rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">Composite Score (0-5)</span> ={" "}
                {columns.find((c) => c.key === "Composite Score (0-5)")!.note!.replace(/^Σ score × Scoring_Model weight: /, "")
                  .split(" + ")
                  .map((t, i) => (
                    <span key={t}>{i ? " + " : ""}<span className="whitespace-nowrap">{t.replace(/ (\d+%)$/, " × $1")}</span></span>
                  ))}
                <button className="ml-1 text-primary underline" onClick={() => setTab("Scoring_Model")}>Edit weights</button>
              </div>
            ) : null}
            <QueryTable columns={columns} source={source} leading={leading} cellExtra={cellExtra} stickyKey={columns.find((c) => c.label === "Micro-Niche (Short Name)")?.key} />
          </>
        ) : (
          <EmptyState icon={Telescope} message="The taxonomy hasn't been synced yet." />
        )
      ) : tab === "Scoring_Model" ? (
        <ScoringModelTab companyId={companyId} />
      ) : (
        <SheetTab companyId={companyId} workbook="dashboard" tab={tab} />
      )}
      <Dialog open={!!confirm} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start qualification</DialogTitle>
            <DialogDescription>
              Run the full qualification research for {confirm?.shortName} ({confirm?.taxonomyId})?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button disabled={run.isPending} onClick={() => confirm && run.mutate(confirm)}>
              {run.isPending ? "Starting…" : "Start"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------- Scoring

const SCORING_REFERENCE_TABS = ["How To Read This", "Scoring Method (Reference)"];

function ScoreChart({ table }: { table: SearchfundTable }) {
  const idx = (key: string) => table.columns.findIndex((c) => c.key === key);
  const [iName, iOpp, iDec, iConf] = [idx("subniche"), idx("opportunity"), idx("decision"), idx("confidence")];
  const rows = table.rows
    .map((r) => ({ name: String(r[iName] ?? ""), opp: toNumber(r[iOpp]), dec: toNumber(r[iDec]), conf: toNumber(r[iConf]) }))
    .filter((r) => r.dec !== null)
    .sort((a, b) => (b.dec ?? 0) - (a.dec ?? 0));
  return (
    <div className="space-y-2 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">Opportunity vs decision score (0–100)</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-3 rounded bg-primary/30" /> Opportunity</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-3 rounded bg-primary" /> Decision</span>
        <span>Evidence confidence on the right</span>
      </div>
      {rows.map((r) => (
        <div key={r.name} className="grid grid-cols-[240px_1fr_48px] items-center gap-3 text-xs">
          <div className="truncate" title={r.name}>{r.name}</div>
          <div className="relative h-5 rounded bg-muted">
            <div className="absolute inset-y-0 left-0 rounded bg-primary/30" style={{ width: `${r.opp ?? 0}%` }} />
            <div className="absolute inset-y-1 left-0 rounded bg-primary" style={{ width: `${r.dec ?? 0}%` }} />
            <span className="absolute right-1 top-0.5 text-[10px] tabular-nums">{r.dec?.toFixed(1)} / {r.opp?.toFixed(1)}</span>
          </div>
          <div className="text-right tabular-nums text-muted-foreground">{r.conf?.toFixed(0)}</div>
        </div>
      ))}
    </div>
  );
}

/** One scoring table, searched/filtered/sorted/paged by the server. */
function ScoringTable({ companyId, table }: { companyId: string; table: SearchfundTable }) {
  const source = useMemo<TableSource>(
    () => ({
      id: [...searchfundKeys.scoring(companyId), table.key],
      fetchPage: (s) => searchfundApi.scoringPage(companyId, table.key, tableParams(s)),
      fetchFacets: (column, s) => searchfundApi.scoringFacets(companyId, table.key, tableParams(s, { column })),
    }),
    [companyId, table.key],
  );
  return <QueryTable columns={table.columns} source={source} stickyKey="subniche" />;
}

function ScoringTab({ companyId }: { companyId: string }) {
  const [tab, setTab] = useState("niche_summary");
  const { data: tables, isLoading } = useQuery({ queryKey: searchfundKeys.scoring(companyId), queryFn: () => searchfundApi.scoring(companyId) });
  if (isLoading) return <PageSkeleton variant="list" />;
  if (!tables?.length || !tables[0].rows.length) return <EmptyState icon={Telescope} message="No scored niches yet." />;

  const summary = tables[0];
  const col = (key: string) => summary.columns.findIndex((c) => c.key === key);
  const statuses = summary.rows.map((r) => String(r[col("scoring_status")] ?? ""));
  const decisions = summary.rows.map((r) => toNumber(r[col("decision")])).filter((n): n is number => n !== null);
  const top = summary.rows.find((r) => r[0] === 1);
  const current = tables.find((t) => t.key === tab);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <Stat label="Scored niches" value={summary.rows.length} />
        <Stat label="Done" value={statuses.filter((s) => s === "COMPLETE").length} tone="text-emerald-600" />
        <Stat label="On hold – gates" value={statuses.filter((s) => s === "HOLD_GATES" || s === "PARTIAL").length} tone="text-amber-600" />
        <Stat label="Avg decision score" value={decisions.length ? (decisions.reduce((a, b) => a + b, 0) / decisions.length).toFixed(1) : "—"} />
        <Stat label="Top ranked" value={<span className="block truncate text-sm">{top ? String(top[1]) : "—"}</span>} />
      </div>
      <SubTabs
        items={[
          ...SCORING_REFERENCE_TABS.slice(0, 1).map((t) => ({ key: t, label: t })),
          ...tables.slice(0, 3).map((t) => ({ key: t.key, label: t.title, count: t.rowCount })),
          { key: "charts", label: "Charts" },
          ...tables.slice(3).map((t) => ({ key: t.key, label: t.title, count: t.rowCount })),
          ...SCORING_REFERENCE_TABS.slice(1).map((t) => ({ key: t, label: t })),
        ]}
        value={tab}
        onChange={setTab}
      />
      {current ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{current.description}</p>
          <ScoringTable key={current.key} companyId={companyId} table={current} />
        </div>
      ) : tab === "charts" ? (
        <ScoreChart table={summary} />
      ) : (
        <SheetTab companyId={companyId} workbook="scoring" tab={tab} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Run Files

const CRITERIA_COLUMNS: SearchfundColumn[] = [
  { key: "id", label: "Criterion ID", type: "text" },
  { key: "name", label: "Criterion Name", type: "text" },
  { key: "scope", label: "Scope", type: "status" },
  { key: "research_status", label: "Research Status", type: "status" },
  { key: "gate", label: "Gate / Overlay Status", type: "status" },
  { key: "signal", label: "Preliminary Signal", type: "status" },
  { key: "confidence", label: "Confidence", type: "status" },
  { key: "score", label: "Provisional Score (1-10)", type: "number" },
  { key: "metrics", label: "Key Metrics", type: "longtext" },
  { key: "finding", label: "Finding", type: "longtext" },
  { key: "interpretation", label: "Interpretation", type: "longtext" },
  { key: "evidence", label: "Evidence", type: "longtext" },
  { key: "contradictions", label: "Contradictions", type: "longtext" },
  { key: "limitations", label: "Limitations", type: "longtext" },
  { key: "missing", label: "Missing Data", type: "longtext" },
  { key: "next", label: "Recommended Next Step", type: "longtext" },
];

const bullets = (items?: readonly string[] | null) => (items ?? []).filter(Boolean).map((s) => `• ${s}`).join("\n");

function criterionRow(c: SearchfundCriterionDoc): Value[] {
  const metrics = (c.metrics ?? [])
    .map((m) => `• ${[m.name, m.value === undefined || m.value === null ? "" : String(m.value), m.unit, m.period ? `(${m.period})` : "", m.geography ? `· ${m.geography}` : ""].filter(Boolean).join(" ")}`)
    .join("\n");
  const evidence = (c.evidence ?? [])
    .map((e) => `• ${[e.source_name, e.publisher, e.data_date, e.directness].filter(Boolean).join(" · ")}${e.claim_supported ? ` — ${e.claim_supported}` : ""}`)
    .join("\n");
  return [
    c.criterion_id ?? null, c.criterion_name ?? null, c.scope ?? null, c.research_status ?? null,
    [c.gate_status, c.overlay_status].filter(Boolean).join(" / ") || null, c.preliminary_signal ?? null, c.confidence ?? null,
    c.provisional_score_1_10 ?? null, metrics || null, c.finding ?? null, c.interpretation ?? null, evidence || null,
    bullets(c.contradictions) || null, bullets(c.limitations) || null, bullets(c.missing_data) || null, c.recommended_next_step ?? null,
  ];
}

function LayerData({ layers }: { layers: SearchfundLayerDoc[] }) {
  const sorted = [...layers].sort((a, b) => a.layerId.localeCompare(b.layerId, undefined, { numeric: true }));
  const [active, setActive] = useState("all");
  const nb = sorted.find((l) => l.doc.niche_boundary)?.doc.niche_boundary;
  const meta = sorted.find((l) => l.doc.run_metadata)?.doc.run_metadata;
  const sources = Array.from(new Set(sorted.flatMap((l) => l.doc.sources_consulted ?? [])));
  const questions = Array.from(new Set(sorted.flatMap((l) => l.doc.open_questions ?? [])));
  const allRows = sorted.flatMap((l) => (l.doc.criteria ?? []).map((c) => [l.layerId, ...criterionRow(c)] as Value[]));
  const shown = active === "all" ? null : sorted.find((l) => l.layerId === active);
  const boundary: Array<[string, string[] | undefined]> = [
    ["Includes", nb?.inclusions],
    ["Excludes", nb?.exclusions],
    ["Classification notes", nb?.classification_notes],
  ];

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="text-lg font-semibold">{nb?.micro_niche ?? "Layer Data"}</div>
        <div className="text-sm text-muted-foreground">{[nb?.niche, nb?.sub_niche].filter(Boolean).join(" → ")}</div>
        <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
          {meta?.as_of_date ? <StatusBadge value={`As of ${meta.as_of_date}`} /> : null}
          {meta?.mode ? <StatusBadge value={`Mode: ${meta.mode}`} /> : null}
          {meta?.geography ? <StatusBadge value={`Geography: ${meta.geography}`} /> : null}
          <StatusBadge value={`${allRows.length} criteria · ${sources.length} sources`} />
        </div>
      </div>
      {nb ? (
        <div className="grid gap-3 md:grid-cols-3">
          {boundary.map(([label, items]) => (
            <div key={label} className="rounded-lg border border-border bg-card p-3 text-xs">
              <div className="mb-1 text-sm font-semibold">{label}</div>
              <div className="whitespace-pre-wrap text-muted-foreground">{bullets(items) || "—"}</div>
            </div>
          ))}
        </div>
      ) : null}
      <SubTabs
        items={[{ key: "all", label: "All layers", count: allRows.length }, ...sorted.map((l) => ({ key: l.layerId, label: `${l.layerId} ${l.doc.layer?.name ?? ""}`, count: l.doc.criteria?.length ?? 0 }))]}
        value={active}
        onChange={setActive}
      />
      {shown?.doc.layer_summary ? (
        <div className="rounded-lg border border-border bg-card p-3 text-sm">
          <div className="mb-1 font-semibold">Layer summary</div>
          <p className="whitespace-pre-wrap text-muted-foreground">{shown.doc.layer_summary}</p>
        </div>
      ) : null}
      <DataTable
        key={active}
        columns={[{ key: "layer", label: "Layer", type: "status" }, ...CRITERIA_COLUMNS]}
        rows={shown ? (shown.doc.criteria ?? []).map((c) => [shown.layerId, ...criterionRow(c)]) : allRows}
        stickyKey="name"
      />
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-3 text-xs">
          <div className="mb-1 text-sm font-semibold">Sources Consulted ({sources.length})</div>
          <div className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">{bullets(sources) || "—"}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-3 text-xs">
          <div className="mb-1 text-sm font-semibold">Open Questions ({questions.length})</div>
          <div className="max-h-80 overflow-auto whitespace-pre-wrap text-muted-foreground">{bullets(questions) || "—"}</div>
        </div>
      </div>
    </div>
  );
}

function RunList({ runs, selected, onSelect }: { runs: SearchfundRun[]; selected: string | null; onSelect: (issue: string) => void }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const statuses = Array.from(new Set(runs.map((r) => r.scoringStatus).filter((s): s is string => !!s))).sort();
  const q = query.trim().toLowerCase();
  const shown = runs.filter(
    (r) => (!status || r.scoringStatus === status) && (!q || [r.issue, r.subniche, r.microNiche, r.niche].some((v) => v?.toLowerCase().includes(q))),
  );
  return (
    <div className="space-y-2">
      <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search runs" className="h-9" />
      <select value={status} onChange={(e) => setStatus(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs">
        <option value="">Status: All</option>
        {statuses.map((s) => (
          <option key={s} value={s}>{STATUS_WORDS[s] ?? s}</option>
        ))}
      </select>
      <div className="max-h-[70vh] space-y-1 overflow-auto rounded-lg border border-border bg-card p-1.5">
        {shown.map((r) => (
          <button
            key={r.issue}
            onClick={() => onSelect(r.issue)}
            className={cn("block w-full rounded-md px-2 py-2 text-left text-xs", r.issue === selected ? "bg-accent" : "hover:bg-accent/50")}
          >
            <div className="font-medium">{r.subniche ?? r.microNiche ?? r.issue}</div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-muted-foreground">
              <span>{r.issue}</span>
              {r.rank ? <span>· #{r.rank}</span> : null}
              {r.decisionScore !== null ? <span>· {r.decisionScore.toFixed(1)}</span> : null}
              {r.scoringStatus ? <StatusBadge value={r.scoringStatus} /> : null}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

const HOW_TO_READ = [
  "Layer Data holds the research behind one micro-niche run, layer by layer (L0 eligibility through L8 audit).",
  "Niche Boundary states exactly what is in and out of scope for this micro-niche.",
  "Each criterion row gives its status, gate/overlay, preliminary signal and confidence, key metrics, finding and interpretation, the evidence behind it, and contradictions, limitations, missing data and the recommended next step.",
  "Filter by layer, signal, confidence or status, or search across every field.",
  "Scores for this run are in the Scoring tab; this tab shows the evidence they were built from.",
];

function FilesTab({ companyId }: { companyId: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [sub, setSub] = useState("data");
  const { data: runs, isLoading } = useQuery({ queryKey: searchfundKeys.runs(companyId), queryFn: () => searchfundApi.runs(companyId) });
  const run = runs?.find((r) => r.issue === selected) ?? runs?.[0] ?? null;
  const { data: layers, isLoading: layersLoading } = useQuery({
    queryKey: searchfundKeys.layers(companyId, run?.issue ?? ""),
    queryFn: () => searchfundApi.runLayers(companyId, run!.issue),
    enabled: !!run,
  });

  if (isLoading) return <PageSkeleton variant="list" />;
  if (!runs?.length) return <EmptyState icon={Telescope} message="No run data yet." />;

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <RunList runs={runs} selected={run?.issue ?? null} onSelect={setSelected} />
      {run ? (
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SubTabs items={[{ key: "read", label: "How To Read This" }, { key: "data", label: "Layer Data" }]} value={sub} onChange={setSub} />
            <div className="flex items-center gap-2">
              <Link to={`/issues/${run.issue}`} className="text-xs text-primary underline">{run.issue}</Link>
              {run.fileId ? (
                <a href={searchfundApi.fileUrl(companyId, run.fileId)} className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent">
                  <Download className="mr-1 h-3.5 w-3.5" /> Download .xlsx
                </a>
              ) : null}
            </div>
          </div>
          {sub === "read" ? (
            <div className="space-y-2 rounded-lg border border-border bg-card p-4 text-sm">
              {HOW_TO_READ.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          ) : layersLoading || !layers ? (
            <PageSkeleton variant="list" />
          ) : (
            <LayerData key={run.issue} layers={layers} />
          )}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- Page

export function SearchFund() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const params = useParams<{ tab?: string }>();
  const tab: PageTab = PAGE_TABS.includes(params.tab as PageTab) ? (params.tab as PageTab) : "taxonomy";

  useEffect(() => {
    setBreadcrumbs([{ label: "SearchFund" }]);
  }, [setBreadcrumbs]);

  const { data: access, isLoading } = useQuery({
    queryKey: searchfundKeys.access(selectedCompanyId!),
    queryFn: () => searchfundApi.access(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) return <EmptyState icon={Telescope} message="Select a company to view SearchFund." />;
  if (isLoading) return <PageSkeleton variant="list" />;
  if (!access?.allowed) return <EmptyState icon={Lock} message="You don't have access to the SearchFund dashboard." />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">SearchFund</h1>
          <p className="text-sm text-muted-foreground">Micro-niche taxonomy, qualification scores and the research behind every run.</p>
        </div>
        <Tabs value={tab} onValueChange={(value) => navigate(value === "taxonomy" ? "/searchfund" : `/searchfund/${value}`)}>
          <TabsList>
            <TabsTrigger value="taxonomy">Taxonomy Dashboard</TabsTrigger>
            <TabsTrigger value="scoring">Scoring</TabsTrigger>
            <TabsTrigger value="files">Run Files</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {tab === "taxonomy" ? <TaxonomyTab companyId={selectedCompanyId} /> : null}
      {tab === "scoring" ? <ScoringTab companyId={selectedCompanyId} /> : null}
      {tab === "files" ? <FilesTab companyId={selectedCompanyId} /> : null}
    </div>
  );
}
