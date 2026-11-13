import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearProviderQuotaCache,
  decideProviderQuotaGate,
  getClaudeProviderQuotaSnapshot,
  isMinimaxBaseUrl,
  minimaxRemainsUrl,
  parseMinimaxRemains,
  resolveClaudeProviderEnv,
  type ProviderQuotaSnapshot,
} from "../services/provider-quota-gate.ts";

// Captured from prod (api.minimax.io, Token Plan key) on 2026-11-13 07:30 UTC
// while runs were failing with 429 "Token Plan usage limit reached".
const EXHAUSTED_BODY = {
  model_remains: [
    {
      start_time: 1794541598714,
      end_time: 1794559598714,
      remains_time: 4565746,
      current_interval_total_count: 0,
      current_interval_usage_count: 0,
      model_name: "general",
      current_weekly_total_count: 0,
      current_weekly_usage_count: 0,
      weekly_start_time: 1794555032960,
      weekly_end_time: 1795159832960,
      weekly_remains_time: 604799992,
      current_interval_status: 2,
      current_interval_remaining_percent: 0,
      current_weekly_status: 1,
      current_weekly_remaining_percent: 100,
    },
  ],
  base_resp: { status_code: 0, status_msg: "success" },
};
const NOW = new Date(1794555032960); // 2026-11-13T07:30:32Z

function okBody(fivePct: number, weeklyPct: number) {
  const entry = EXHAUSTED_BODY.model_remains[0]!;
  return {
    ...EXHAUSTED_BODY,
    model_remains: [{
      ...entry,
      current_interval_status: 1,
      current_interval_remaining_percent: fivePct,
      current_weekly_remaining_percent: weeklyPct,
    }],
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  clearProviderQuotaCache();
});

describe("parseMinimaxRemains", () => {
  it("reads the 5-hour and weekly windows from the real prod response", () => {
    expect(parseMinimaxRemains(EXHAUSTED_BODY, NOW)).toEqual([
      {
        key: "five_hour",
        label: "5-hour window",
        remainingPercent: 0,
        providerExhausted: true,
        resetsAt: "2026-11-13T08:46:38.714Z",
      },
      {
        key: "weekly",
        label: "Weekly window",
        remainingPercent: 100,
        providerExhausted: false,
        resetsAt: "2026-11-20T07:30:32.960Z",
      },
    ]);
  });

  it("throws on a non-zero base_resp status", () => {
    expect(() =>
      parseMinimaxRemains({ base_resp: { status_code: 2062, status_msg: "no active token plan" } }, NOW),
    ).toThrow(/2062.*no active token plan/);
  });
});

describe("decideProviderQuotaGate", () => {
  const snap = (windows: ProviderQuotaSnapshot["windows"]): ProviderQuotaSnapshot => ({
    provider: "minimax",
    baseUrl: "https://api.minimax.io/anthropic",
    checkedAt: NOW.toISOString(),
    windows,
    error: null,
  });

  it("holds until the 5-hour reset when that window is used up", () => {
    const decision = decideProviderQuotaGate(snap(parseMinimaxRemains(EXHAUSTED_BODY, NOW)), 5);
    expect(decision.blocked).toBe(true);
    expect(decision.resumeAt).toBe("2026-11-13T08:46:38.714Z");
    expect(decision.reason).toBe("5-hour window 0% left (exhausted)");
  });

  it("holds at the reserve and waits for the later reset when both windows are low", () => {
    const decision = decideProviderQuotaGate(snap(parseMinimaxRemains(okBody(4, 3), NOW)), 5);
    expect(decision.blocked).toBe(true);
    expect(decision.resumeAt).toBe("2026-11-20T07:30:32.960Z");
  });

  it("does not hold above the reserve", () => {
    expect(decideProviderQuotaGate(snap(parseMinimaxRemains(okBody(6, 80), NOW)), 5).blocked).toBe(false);
  });
});

describe("resolveClaudeProviderEnv", () => {
  it("prefers per-agent env, then Claude settings env, then process env", () => {
    const processEnv = { ANTHROPIC_BASE_URL: "https://proc.example", ANTHROPIC_AUTH_TOKEN: "proc" };
    expect(resolveClaudeProviderEnv({ processEnv, settingsEnv: {} })).toEqual({
      baseUrl: "https://proc.example",
      token: "proc",
    });
    expect(
      resolveClaudeProviderEnv({
        processEnv,
        settingsEnv: { ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic", ANTHROPIC_AUTH_TOKEN: "settings" },
      }),
    ).toEqual({ baseUrl: "https://api.minimax.io/anthropic", token: "settings" });
    expect(
      resolveClaudeProviderEnv({
        processEnv,
        settingsEnv: { ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic" },
        agentEnv: { ANTHROPIC_BASE_URL: { type: "plain", value: "https://api.anthropic.com" } },
      }).baseUrl,
    ).toBe("https://api.anthropic.com");
  });

  it("recognises MiniMax hosts and builds the remains URL from the origin", () => {
    expect(isMinimaxBaseUrl("https://api.minimax.io/anthropic")).toBe(true);
    expect(isMinimaxBaseUrl("https://api.minimaxi.com/anthropic")).toBe(true);
    expect(isMinimaxBaseUrl("https://api.anthropic.com")).toBe(false);
    expect(minimaxRemainsUrl("https://api.minimax.io/anthropic")).toBe("https://api.minimax.io/v1/token_plan/remains");
  });
});

describe("getClaudeProviderQuotaSnapshot", () => {
  const env = { baseUrl: "https://api.minimax.io/anthropic", token: "sk-cp-test" };

  it("calls the remains endpoint with the bearer key and caches the result", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(okBody(50, 90)));
    const first = await getClaudeProviderQuotaSnapshot(env, { fetchImpl, now: () => NOW });
    const second = await getClaudeProviderQuotaSnapshot(env, { fetchImpl, now: () => NOW });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.minimax.io/v1/token_plan/remains");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-cp-test");
    expect(first.windows[0]?.remainingPercent).toBe(50);
    expect(second).toBe(first);
  });

  it("re-checks right after an exhausted window resets instead of waiting out the TTL", async () => {
    let nowMs = NOW.getTime();
    const fetchImpl = vi.fn(async () => jsonResponse(EXHAUSTED_BODY));
    const ttlMs = 60 * 60_000; // longer than the 76 minutes to reset would never re-check early
    await getClaudeProviderQuotaSnapshot(env, { fetchImpl, now: () => new Date(nowMs), ttlMs: 2 * ttlMs });
    nowMs = Date.parse("2026-11-13T08:46:40.000Z");
    await getClaudeProviderQuotaSnapshot(env, { fetchImpl, now: () => new Date(nowMs), ttlMs: 2 * ttlMs });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports an error instead of throwing when the API fails", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500));
    const snapshot = await getClaudeProviderQuotaSnapshot(env, { fetchImpl, now: () => NOW });
    expect(snapshot.error).toBe("minimax remains returned HTTP 500");
    expect(snapshot.windows).toEqual([]);
  });

  it("does not call anything for non-MiniMax or unconfigured providers", async () => {
    const fetchImpl = vi.fn();
    expect((await getClaudeProviderQuotaSnapshot({ baseUrl: "https://api.anthropic.com", token: "x" }, { fetchImpl })).provider)
      .toBe("unsupported");
    expect((await getClaudeProviderQuotaSnapshot({ baseUrl: null, token: null }, { fetchImpl })).provider)
      .toBe("unconfigured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
