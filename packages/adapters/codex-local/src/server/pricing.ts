/**
 * Codex CLI reports token usage but never a dollar cost, so API-billed runs are
 * priced here from per-model list rates (USD per 1M tokens). Cache reads and
 * cache writes are billed at their own rates, separate from fresh input.
 *
 * Override or extend the table with PAPERCLIP_CODEX_MODEL_PRICING, e.g.
 *   {"gpt-5.6-luna":{"input":0.2,"cachedInput":0.02,"cacheWrite":0.25,"output":1.2}}
 */
export interface CodexModelPricing {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}

export interface CodexRawUsage {
  /** Codex input_tokens: includes cache reads and cache writes. */
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  /** Includes reasoning output tokens, which bill as output. */
  outputTokens: number;
}

const DEFAULT_CODEX_MODEL_PRICING: Record<string, CodexModelPricing> = {
  "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1.2 },
};

function isRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parsePricingOverrides(raw: string | undefined): Record<string, CodexModelPricing> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<CodexModelPricing>>;
    const out: Record<string, CodexModelPricing> = {};
    for (const [model, rates] of Object.entries(parsed ?? {})) {
      if (!rates || typeof rates !== "object") continue;
      const { input, output } = rates;
      if (!isRate(input) || !isRate(output)) continue;
      out[model.trim().toLowerCase()] = {
        input,
        output,
        cachedInput: isRate(rates.cachedInput) ? rates.cachedInput : input,
        cacheWrite: isRate(rates.cacheWrite) ? rates.cacheWrite : input,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function resolveCodexModelPricing(
  model: string,
  env: Record<string, string | undefined>,
): CodexModelPricing | null {
  const key = model.trim().toLowerCase();
  if (!key) return null;
  const table: Record<string, CodexModelPricing> = {
    ...DEFAULT_CODEX_MODEL_PRICING,
    ...parsePricingOverrides(env.PAPERCLIP_CODEX_MODEL_PRICING),
  };
  return table[key] ?? null;
}

/** USD cost of one Codex run, or null when the model has no known rates. */
export function computeCodexCostUsd(
  model: string,
  usage: CodexRawUsage,
  env: Record<string, string | undefined>,
): number | null {
  const pricing = resolveCodexModelPricing(model, env);
  if (!pricing) return null;
  const cached = Math.max(0, usage.cachedInputTokens);
  const cacheWrite = Math.max(0, usage.cacheWriteInputTokens);
  const fresh = Math.max(0, usage.inputTokens - cached - cacheWrite);
  const output = Math.max(0, usage.outputTokens);
  return (
    (fresh * pricing.input +
      cached * pricing.cachedInput +
      cacheWrite * pricing.cacheWrite +
      output * pricing.output) /
    1_000_000
  );
}
