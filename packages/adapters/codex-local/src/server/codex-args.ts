import { asBoolean, asString, asStringArray } from "@paperclipai/adapter-utils/server-utils";
import {
  CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS,
  isCodexLocalFastModeSupported,
} from "../index.js";

export type BuildCodexExecArgsResult = {
  args: string[];
  model: string;
  fastModeRequested: boolean;
  fastModeApplied: boolean;
  fastModeIgnoredReason: string | null;
};

export type CodexMcpOverrides = {
  args: string[];
  env: Record<string, string>;
  serverNames: string[];
};

function readExtraArgs(config: unknown): string[] {
  const fromExtraArgs = asStringArray(asRecord(config).extraArgs);
  if (fromExtraArgs.length > 0) return fromExtraArgs;
  return asStringArray(asRecord(config).args);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function codexMcpKey(serverName: string, fallback: string): string | null {
  const normalized = serverName.trim() || fallback;
  return /^[A-Za-z0-9_-]+$/.test(normalized) ? normalized : null;
}

function codexMcpEnvName(serverName: string): string {
  const normalized = serverName.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `PAPERCLIP_MCP_${(normalized || "SERVER").toUpperCase()}_TOKEN`;
}

function readAuthorizationHeader(headers: unknown): string {
  const record = asRecord(headers);
  const value = Object.entries(record).find(([key]) => key.toLowerCase() === "authorization")?.[1];
  const header = asString(value, "").trim();
  return header.replace(/^Bearer\s+/i, "").trim();
}

/** Convert Paperclip's run-scoped HTTP MCP hints into safe Codex overrides. */
export function buildCodexMcpOverrides(value: unknown): CodexMcpOverrides {
  const root = asRecord(value);
  const args: string[] = [];
  const env: Record<string, string> = {};
  const serverNames: string[] = [];

  for (const [fallbackName, rawConfig] of Object.entries(root)) {
    const config = asRecord(rawConfig);
    const type = asString(config.type, "").trim().toLowerCase();
    if (type && type !== "http" && type !== "streamable_http") continue;
    const url = asString(config.url, "").trim();
    const accessToken =
      asString(config.accessToken, "").trim() ||
      asString(config.token, "").trim() ||
      readAuthorizationHeader(config.headers);
    if (!url || !accessToken) continue;

    const serverName = codexMcpKey(asString(config.serverName, fallbackName), fallbackName);
    if (!serverName) continue;

    const envName = codexMcpEnvName(serverName);
    args.push(
      "-c",
      `mcp_servers.${serverName}.url=${JSON.stringify(url)}`,
      "-c",
      `mcp_servers.${serverName}.bearer_token_env_var=${JSON.stringify(envName)}`,
      "-c",
      `mcp_servers.${serverName}.enabled=true`,
    );
    env[envName] = accessToken;
    serverNames.push(serverName);
  }

  return { args, env, serverNames };
}

function formatFastModeSupportedModels(): string {
  return `${CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS.join(", ")} or manually configured model IDs`;
}

export function buildCodexExecArgs(
  config: unknown,
  options: {
    resumeSessionId?: string | null;
    skipGitRepoCheck?: boolean;
    mcpOverrides?: string[];
  } = {},
): BuildCodexExecArgsResult {
  const record = asRecord(config);
  const model = asString(record.model, "").trim();
  const modelReasoningEffort = asString(
    record.modelReasoningEffort,
    asString(record.reasoningEffort, ""),
  ).trim();
  const search = asBoolean(record.search, false);
  const fastModeRequested = asBoolean(record.fastMode, false);
  const fastModeApplied = fastModeRequested && isCodexLocalFastModeSupported(model);
  const bypass = asBoolean(
    record.dangerouslyBypassApprovalsAndSandbox,
    asBoolean(record.dangerouslyBypassSandbox, false),
  );
  const extraArgs = readExtraArgs(record);

  const args = ["exec", "--json"];
  if (options.skipGitRepoCheck) args.push("--skip-git-repo-check");
  if (search) args.unshift("--search");
  if (bypass) args.push("--dangerously-bypass-approvals-and-sandbox");
  if (model) args.push("--model", model);
  if (modelReasoningEffort) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(modelReasoningEffort)}`);
  }
  if (fastModeApplied) {
    args.push("-c", 'service_tier="fast"', "-c", "features.fast_mode=true");
  }
  if (options.mcpOverrides && options.mcpOverrides.length > 0) {
    args.push(...options.mcpOverrides);
  }
  if (extraArgs.length > 0) args.push(...extraArgs);
  if (options.resumeSessionId) args.push("resume", options.resumeSessionId, "-");
  else args.push("-");

  return {
    args,
    model,
    fastModeRequested,
    fastModeApplied,
    fastModeIgnoredReason:
      fastModeRequested && !fastModeApplied
        ? `Configured fast mode is currently only supported on ${formatFastModeSupportedModels()}; Paperclip will ignore it for model ${model || "(default)"}.`
        : null,
  };
}
