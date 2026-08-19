import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_OPENCODE_LOCAL_MODEL,
  models as openCodeDefaultModels,
  modelProfiles as openCodeDefaultModelProfiles,
} from "../index.js";
import {
  ensureOpenCodeModelConfiguredAndAvailable,
  listOpenCodeModels,
  requireOpenCodeModelId,
  resolveOpenCodeCommand,
  resetOpenCodeModelsCacheForTests,
} from "./models.js";

// Authoritative list from the deployment's `opencode models` output. Kept in
// sync with the adapter's static `models` list so defaults never reference a
// model absent from the running runtime.
const DEPLOYED_OPENCODE_MODEL_IDS = [
  "opencode/big-pickle",
  "opencode/deepseek-v4-flash-free",
  "opencode/hy3-free",
  "opencode/laguna-s-2.1-free",
  "opencode/mimo-v2.5-free",
  "opencode/nemotron-3-ultra-free",
  "opencode/nemotron-3.5-lightning-free",
  "opencode-go/deepseek-v4-flash",
  "opencode-go/deepseek-v4-pro",
  "opencode-go/glm-5.1",
  "opencode-go/glm-5.2",
  "opencode-go/glm-5.3",
  "opencode-go/gpt-5.6-luna",
  "opencode-go/grok-4.5",
  "opencode-go/hy3",
  "opencode-go/kimi-k2.6",
  "opencode-go/kimi-k2.7-code",
  "opencode-go/kimi-k3",
  "opencode-go/mimo-v2.5",
  "opencode-go/mimo-v2.5-pro",
  "opencode-go/minimax-m2.7",
  "opencode-go/minimax-m3",
  "opencode-go/muse-spark-1.2-contributor",
  "opencode-go/qwen3.6-plus",
  "opencode-go/qwen3.7-max",
  "opencode-go/qwen3.7-plus",
  "opencode-go/qwen3.8-max",
];

describe("openCode models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
    resetOpenCodeModelsCacheForTests();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(listOpenCodeModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });

  it("accepts a provider/model id without running discovery", () => {
    expect(requireOpenCodeModelId(DEFAULT_OPENCODE_LOCAL_MODEL)).toBe(
      DEFAULT_OPENCODE_LOCAL_MODEL,
    );
  });

  it("defaults to a model deployed in the opencode runtime", () => {
    expect(DEFAULT_OPENCODE_LOCAL_MODEL).toBe("opencode-go/deepseek-v4-flash");
    expect(DEPLOYED_OPENCODE_MODEL_IDS).toContain(DEFAULT_OPENCODE_LOCAL_MODEL);
    expect(openCodeDefaultModels[0]?.id).toBe(DEFAULT_OPENCODE_LOCAL_MODEL);
  });

  it("declares static models and cheap profile using only deployed model ids", () => {
    const staticIds = openCodeDefaultModels.map((entry) => entry.id);
    expect(staticIds).toEqual([...new Set(staticIds)]);

    for (const id of staticIds) {
      expect(DEPLOYED_OPENCODE_MODEL_IDS).toContain(id);
    }

    const cheapModel = openCodeDefaultModelProfiles.find(
      (profile) => profile.key === "cheap",
    )?.adapterConfig?.model;
    expect(cheapModel).toBe(DEFAULT_OPENCODE_LOCAL_MODEL);
    expect(staticIds).toContain(cheapModel);
    expect(DEPLOYED_OPENCODE_MODEL_IDS).toContain(cheapModel);
  });

  it("uses the deployment command for the UI's default command value", () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "/home/ubuntu/.opencode/bin/opencode";
    expect(resolveOpenCodeCommand("opencode")).toBe("/home/ubuntu/.opencode/bin/opencode");
    expect(resolveOpenCodeCommand("/custom/opencode")).toBe("/custom/opencode");
  });

  it("rejects malformed provider/model ids before discovery", () => {
    expect(() => requireOpenCodeModelId("gpt-5.2-codex")).toThrow(
      "OpenCode requires `adapterConfig.model`",
    );
    expect(() => requireOpenCodeModelId("openai/")).toThrow(
      "OpenCode requires `adapterConfig.model`",
    );
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openai/gpt-5",
      }),
    ).rejects.toThrow("Failed to start command");
  });

  it("skips the availability check when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
      }),
    ).resolves.toEqual([
      { id: "anthropic/tensorix/deepseek/deepseek-chat-v3.1", label: "anthropic/tensorix/deepseek/deepseek-chat-v3.1" },
    ]);
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "anthropic/gateway/some-model" }),
    ).resolves.toEqual([{ id: "anthropic/gateway/some-model", label: "anthropic/gateway/some-model" }]);
  });

  it("still enforces provider/model format when OPENCODE_ALLOW_ALL_MODELS is set", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "not-a-valid-id",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
      }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });
});
