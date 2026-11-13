import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "../middleware/logger.js";

/**
 * Provider quota gate.
 *
 * claude_local agents run the Claude Code CLI, which can be pointed at a
 * third-party Anthropic-compatible provider with ANTHROPIC_BASE_URL. When that
 * provider sells a plan with usage windows (MiniMax Token Plan: a rolling
 * 5-hour window and a weekly window), starting runs while a window is used up
 * only produces 429 "usage limit reached" failures. This module reads the
 * plan's remaining quota so the scheduler can keep runs queued until the
 * window resets.
 *
 * Supported today: MiniMax Token Plan (GET {origin}/v1/token_plan/remains).
 * Any other provider reports "unsupported" and never blocks.
 */

export type ProviderQuotaWindowKey = "five_hour" | "weekly";

export interface ProviderQuotaWindow {
  key: ProviderQuotaWindowKey;
  label: string;
  /** 0-100, null when the provider did not report it. */
  remainingPercent: number | null;
  /** Provider says this window is used up, independent of our reserve. */
  providerExhausted: boolean;
  /** ISO time the window resets, when known and in the future. */
  resetsAt: string | null;
}

export interface ProviderQuotaSnapshot {
  provider: "minimax" | "unsupported" | "unconfigured";
  baseUrl: string | null;
  checkedAt: string;
  windows: ProviderQuotaWindow[];
  error: string | null;
}

export interface ProviderQuotaGateDecision {
  blocked: boolean;
  /** When every blocking window has reset; null if unknown. */
  resumeAt: string | null;
  reason: string | null;
  snapshot: ProviderQuotaSnapshot;
}

export interface ClaudeProviderEnv {
  baseUrl: string | null;
  token: string | null;
}

const MINIMAX_HOST_RE = /(^|\.)minimaxi?\.(io|com)$/i;
const DEFAULT_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 8_000;

function readNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** adapterConfig.env values are either plain strings or { type: "plain", value }. */
function readEnvBindingValue(value: unknown): string | null {
  const direct = readNonEmpty(value);
  if (direct) return direct;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.type === "plain" || record.type === undefined) return readNonEmpty(record.value);
  }
  return null;
}

function claudeSettingsPath(env: NodeJS.ProcessEnv) {
  const configDir = readNonEmpty(env.CLAUDE_CONFIG_DIR) ?? path.join(os.homedir(), ".claude");
  return path.join(configDir, "settings.json");
}

function readClaudeSettingsEnv(settingsPath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as { env?: unknown };
    return parsed.env && typeof parsed.env === "object" ? (parsed.env as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Resolve the provider URL and key the Claude CLI will use. Precedence matches
 * what the agent process sees: per-agent adapter env, then ~/.claude/settings.json
 * env (Claude Code applies it over inherited env), then the server's own env.
 */
export function resolveClaudeProviderEnv(input: {
  agentEnv?: unknown;
  processEnv?: NodeJS.ProcessEnv;
  settingsEnv?: Record<string, unknown>;
} = {}): ClaudeProviderEnv {
  const processEnv = input.processEnv ?? process.env;
  const settingsEnv = input.settingsEnv ?? readClaudeSettingsEnv(claudeSettingsPath(processEnv));
  const agentEnv = input.agentEnv && typeof input.agentEnv === "object"
    ? (input.agentEnv as Record<string, unknown>)
    : {};
  const pick = (key: string) =>
    readEnvBindingValue(agentEnv[key]) ?? readNonEmpty(settingsEnv[key]) ?? readNonEmpty(processEnv[key]);
  return {
    baseUrl: pick("ANTHROPIC_BASE_URL"),
    token: pick("ANTHROPIC_AUTH_TOKEN") ?? pick("ANTHROPIC_API_KEY"),
  };
}

export function isMinimaxBaseUrl(baseUrl: string | null | undefined) {
  if (!baseUrl) return false;
  try {
    return MINIMAX_HOST_RE.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

export function minimaxRemainsUrl(baseUrl: string) {
  return `${new URL(baseUrl).origin}/v1/token_plan/remains`;
}

function toIsoIfFuture(ms: unknown, now: Date): string | null {
  const value = typeof ms === "number" ? ms : Number(ms);
  if (!Number.isFinite(value) || value <= now.getTime()) return null;
  return new Date(value).toISOString();
}

function toPercent(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Parse MiniMax /v1/token_plan/remains. Observed shape (2026-11-13):
 * { model_remains: [{ model_name: "general",
 *     end_time, current_interval_status, current_interval_remaining_percent,
 *     weekly_end_time, current_weekly_status, current_weekly_remaining_percent, ... }],
 *   base_resp: { status_code: 0, status_msg: "success" } }
 * status 2 with 0% remaining was observed while every request returned
 * 429 "Token Plan usage limit reached", so status 2 is treated as exhausted.
 */
export function parseMinimaxRemains(body: unknown, now: Date = new Date()): ProviderQuotaWindow[] {
  const record = (body ?? {}) as Record<string, unknown>;
  const baseResp = (record.base_resp ?? {}) as Record<string, unknown>;
  const statusCode = Number(baseResp.status_code ?? 0);
  if (statusCode !== 0) {
    throw new Error(`minimax remains returned status_code ${statusCode}: ${String(baseResp.status_msg ?? "")}`.trim());
  }
  const entries = Array.isArray(record.model_remains) ? (record.model_remains as Record<string, unknown>[]) : [];
  const entry = entries.find((e) => e.model_name === "general") ?? entries[0];
  if (!entry) throw new Error("minimax remains response had no model_remains entries");

  return [
    {
      key: "five_hour",
      label: "5-hour window",
      remainingPercent: toPercent(entry.current_interval_remaining_percent),
      providerExhausted: Number(entry.current_interval_status) === 2,
      resetsAt: toIsoIfFuture(entry.end_time, now),
    },
    {
      key: "weekly",
      label: "Weekly window",
      remainingPercent: toPercent(entry.current_weekly_remaining_percent),
      providerExhausted: Number(entry.current_weekly_status) === 2,
      resetsAt: toIsoIfFuture(entry.weekly_end_time, now),
    },
  ];
}

export function decideProviderQuotaGate(
  snapshot: ProviderQuotaSnapshot,
  reservePercent: number,
): ProviderQuotaGateDecision {
  const blocking = snapshot.windows.filter(
    (w) => w.providerExhausted || (w.remainingPercent !== null && w.remainingPercent <= reservePercent),
  );
  if (blocking.length === 0) {
    return { blocked: false, resumeAt: null, reason: null, snapshot };
  }
  const resets = blocking.map((w) => w.resetsAt);
  const resumeAt = resets.every((r): r is string => r !== null)
    ? resets.reduce((latest, r) => (r > latest ? r : latest))
    : null;
  const reason = blocking
    .map((w) => `${w.label} ${w.remainingPercent ?? "?"}% left${w.providerExhausted ? " (exhausted)" : ""}`)
    .join("; ");
  return { blocked: true, resumeAt, reason, snapshot };
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface CacheEntry {
  snapshot: ProviderQuotaSnapshot;
  expiresAtMs: number;
}

// One cache per process, shared by every heartbeatService instance.
const snapshotCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ProviderQuotaSnapshot>>();

export function clearProviderQuotaCache() {
  snapshotCache.clear();
  inflight.clear();
}

async function fetchMinimaxSnapshot(
  providerEnv: ClaudeProviderEnv,
  fetchImpl: FetchLike,
  now: () => Date,
): Promise<ProviderQuotaSnapshot> {
  const baseUrl = providerEnv.baseUrl!;
  const checkedAt = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(minimaxRemainsUrl(baseUrl), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${providerEnv.token}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`minimax remains returned HTTP ${resp.status}`);
    const windows = parseMinimaxRemains(await resp.json(), checkedAt);
    return { provider: "minimax", baseUrl, checkedAt: checkedAt.toISOString(), windows, error: null };
  } catch (err) {
    return {
      provider: "minimax",
      baseUrl,
      checkedAt: checkedAt.toISOString(),
      windows: [],
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface ProviderQuotaGateOptions {
  fetchImpl?: FetchLike;
  now?: () => Date;
  ttlMs?: number;
}

/**
 * Current quota snapshot for the provider an agent's Claude CLI talks to.
 * Cached for ttlMs (default 60s); a blocked snapshot expires early at the
 * reset time so runs start promptly after the window rolls over.
 */
export async function getClaudeProviderQuotaSnapshot(
  providerEnv: ClaudeProviderEnv,
  options: ProviderQuotaGateOptions = {},
): Promise<ProviderQuotaSnapshot> {
  const now = options.now ?? (() => new Date());
  if (!providerEnv.baseUrl || !providerEnv.token) {
    return { provider: "unconfigured", baseUrl: providerEnv.baseUrl, checkedAt: now().toISOString(), windows: [], error: null };
  }
  if (!isMinimaxBaseUrl(providerEnv.baseUrl)) {
    return { provider: "unsupported", baseUrl: providerEnv.baseUrl, checkedAt: now().toISOString(), windows: [], error: null };
  }

  const cacheKey = createHash("sha256").update(`${providerEnv.baseUrl}\n${providerEnv.token}`).digest("hex");
  const cached = snapshotCache.get(cacheKey);
  if (cached && cached.expiresAtMs > now().getTime()) return cached.snapshot;

  const pending = inflight.get(cacheKey);
  if (pending) return pending;

  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const request = fetchMinimaxSnapshot(providerEnv, options.fetchImpl ?? fetch, now)
    .then((snapshot) => {
      const nowMs = now().getTime();
      let expiresAtMs = nowMs + ttlMs;
      for (const window of snapshot.windows) {
        if (!window.resetsAt) continue;
        const resetMs = Date.parse(window.resetsAt);
        if ((window.providerExhausted || window.remainingPercent === 0) && resetMs > nowMs) {
          expiresAtMs = Math.min(expiresAtMs, resetMs + 1_000);
        }
      }
      if (snapshot.error) {
        logger.warn({ provider: snapshot.provider, error: snapshot.error }, "provider quota check failed; not gating runs");
      }
      snapshotCache.set(cacheKey, { snapshot, expiresAtMs });
      return snapshot;
    })
    .finally(() => {
      inflight.delete(cacheKey);
    });
  inflight.set(cacheKey, request);
  return request;
}
