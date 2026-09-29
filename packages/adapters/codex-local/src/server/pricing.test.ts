import { describe, expect, it } from "vitest";
import { computeCodexCostUsd } from "./pricing.js";

describe("computeCodexCostUsd", () => {
  it("prices fresh input, cache reads, cache writes, and output at their own rates", () => {
    // 1M fresh, 2M cached, 1M cache-write inside 4M input; 1M output.
    const cost = computeCodexCostUsd(
      "gpt-5.6-luna",
      { inputTokens: 4_000_000, cachedInputTokens: 2_000_000, cacheWriteInputTokens: 1_000_000, outputTokens: 1_000_000 },
      {},
    );
    expect(cost).toBeCloseTo(0.2 + 2 * 0.02 + 0.25 + 1.2, 10);
  });

  it("honors PAPERCLIP_CODEX_MODEL_PRICING and leaves unknown models unpriced", () => {
    const env = { PAPERCLIP_CODEX_MODEL_PRICING: JSON.stringify({ "my-model": { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 4 } }) };
    expect(computeCodexCostUsd("my-model", { inputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1_000_000 }, env)).toBeCloseTo(5, 10);
    expect(computeCodexCostUsd("unknown-model", { inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1 }, {})).toBeNull();
  });
});
