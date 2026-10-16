import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "opencode_local";
export const label = "OpenCode (local)";

// Use OpenCode's official installer instead of `npm install -g opencode-ai`.
// The npm package reifies four large Linux x64 prebuilt-binary subpackages
// (linux-x64, linux-x64-musl, linux-x64-baseline, linux-x64-baseline-musl) in
// parallel even though only one matches the sandbox; on bandwidth-constrained
// sandboxes (e.g. Cloudflare) that exceeded the 240s install budget. The
// official installer fetches a single arch-specific binary into
// `$HOME/.opencode/bin` and tries to add it to PATH via `~/.bashrc`. That
// rc-file path is only sourced by interactive/login shells, so non-login
// `sh -c` probe invocations (used by the runtime PATH check) cannot find the
// binary. We fix that by symlinking the installed binary into a directory on
// the non-login `sh -c` PATH: prefer `/usr/local/bin` (universally on the
// default PATH on Linux distros) when root or passwordless sudo is available,
// otherwise fall back to `$HOME/.local/bin` (which is on the default PATH on
// the exe.dev sandbox image and most modern home-managed Linux images).
//
// Security tradeoff: this is `curl | bash` without a SHA-256 verification of
// the install script. We accept this because:
//   1. The install runs inside an isolated, ephemeral sandbox — blast radius
//      is bounded to that sandbox's secrets and disk.
//   2. The prior `npm install -g opencode-ai` is also unverified code
//      execution from a third-party registry; this is not strictly worse.
//   3. OpenCode does not publish per-release SHA-256 checksums in a stable
//      location, and pinning a version + hash here would require manual
//      version bumps on every OpenCode release.
// The `set -e` (implied by Bash's default with `-fsSL` upstream of a piped
// shell) and `curl -fsSL` give us fail-fast behavior on HTTP errors. If
// OpenCode starts publishing a stable checksum/signature, switch to fetching
// a versioned tarball + verifying the digest before exec.
export const SANDBOX_INSTALL_COMMAND =
  'curl -fsSL https://opencode.ai/install | bash && ' +
  'if [ -x "$HOME/.opencode/bin/opencode" ]; then ' +
  'if [ "$(id -u)" -eq 0 ]; then ' +
  'ln -sf "$HOME/.opencode/bin/opencode" /usr/local/bin/opencode; ' +
  'elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then ' +
  'sudo ln -sf "$HOME/.opencode/bin/opencode" /usr/local/bin/opencode; ' +
  'else ' +
  'mkdir -p "$HOME/.local/bin" && ' +
  'ln -sf "$HOME/.opencode/bin/opencode" "$HOME/.local/bin/opencode"; ' +
  'fi; ' +
  'fi';

export const DEFAULT_OPENCODE_LOCAL_MODEL = "opencode-go/deepseek-v4-flash";
export const DEFAULT_OPENCODE_CHEAP_MODEL = DEFAULT_OPENCODE_LOCAL_MODEL;

export function isValidOpenCodeModelId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  const slashIndex = trimmed.indexOf("/");
  return Boolean(trimmed) && slashIndex > 0 && slashIndex !== trimmed.length - 1;
}

export const models: Array<{ id: string; label: string }> = [
  { id: DEFAULT_OPENCODE_LOCAL_MODEL, label: DEFAULT_OPENCODE_LOCAL_MODEL },
  { id: "opencode/big-pickle", label: "opencode/big-pickle" },
  { id: "opencode/deepseek-v4-flash-free", label: "opencode/deepseek-v4-flash-free" },
  { id: "opencode/hy3-free", label: "opencode/hy3-free" },
  { id: "opencode/laguna-s-2.1-free", label: "opencode/laguna-s-2.1-free" },
  { id: "opencode/mimo-v2.5-free", label: "opencode/mimo-v2.5-free" },
  { id: "opencode/nemotron-3-ultra-free", label: "opencode/nemotron-3-ultra-free" },
  { id: "opencode/nemotron-3.5-lightning-free", label: "opencode/nemotron-3.5-lightning-free" },
  { id: "opencode-go/deepseek-v4-pro", label: "opencode-go/deepseek-v4-pro" },
  { id: "opencode-go/glm-5.1", label: "opencode-go/glm-5.1" },
  { id: "opencode-go/glm-5.2", label: "opencode-go/glm-5.2" },
  { id: "opencode-go/glm-5.3", label: "opencode-go/glm-5.3" },
  { id: "opencode-go/gpt-5.6-luna", label: "opencode-go/gpt-5.6-luna" },
  { id: "opencode-go/grok-4.5", label: "opencode-go/grok-4.5" },
  { id: "opencode-go/hy3", label: "opencode-go/hy3" },
  { id: "opencode-go/kimi-k2.6", label: "opencode-go/kimi-k2.6" },
  { id: "opencode-go/kimi-k2.7-code", label: "opencode-go/kimi-k2.7-code" },
  { id: "opencode-go/kimi-k3", label: "opencode-go/kimi-k3" },
  { id: "opencode-go/mimo-v2.5", label: "opencode-go/mimo-v2.5" },
  { id: "opencode-go/mimo-v2.5-pro", label: "opencode-go/mimo-v2.5-pro" },
  { id: "opencode-go/minimax-m2.7", label: "opencode-go/minimax-m2.7" },
  { id: "opencode-go/minimax-m3", label: "opencode-go/minimax-m3" },
  { id: "opencode-go/muse-spark-1.2-contributor", label: "opencode-go/muse-spark-1.2-contributor" },
  { id: "opencode-go/qwen3.6-plus", label: "opencode-go/qwen3.6-plus" },
  { id: "opencode-go/qwen3.7-max", label: "opencode-go/qwen3.7-max" },
  { id: "opencode-go/qwen3.7-plus", label: "opencode-go/qwen3.7-plus" },
  { id: "opencode-go/qwen3.8-max", label: "opencode-go/qwen3.8-max" },
];

export function buildOpenCodeModelProfiles(
  env: NodeJS.ProcessEnv = typeof process === "undefined" ? {} : process.env,
): AdapterModelProfileDefinition[] {
  const override = (env.PAPERCLIP_OPENCODE_CHEAP_MODEL ?? env.PAPERCLIP_OPENCODE_SMALL_MODEL)?.trim();

  return [
    {
      key: "cheap",
      label: "Cheap",
      description: "Use the deployed OpenCode model as the budget lane.",
      adapterConfig: override
        ? { model: override }
        : { model: DEFAULT_OPENCODE_CHEAP_MODEL, variant: "low" },
      source: "adapter_default",
    },
  ];
}

export const modelProfiles: AdapterModelProfileDefinition[] = buildOpenCodeModelProfiles();

export const agentConfigurationDoc = `# opencode_local agent configuration

Adapter: opencode_local

Use when:
- You want Paperclip to run OpenCode locally as the agent runtime
- You want provider/model routing in OpenCode format (provider/model)
- You want OpenCode session resume across heartbeats via --session

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- OpenCode CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- model (string, required): OpenCode model id in provider/model format (for example opencode-go/deepseek-v4-flash)
- variant (string, optional): provider-specific reasoning/profile variant passed as --variant (for example minimal|low|medium|high|xhigh|max)
- dangerouslySkipPermissions (boolean, optional): inject a runtime OpenCode config that allows \`external_directory\` access without interactive prompts; defaults to true for unattended Paperclip runs
- promptTemplate (string, optional): run prompt template
- command (string, optional): defaults to "opencode"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- OpenCode supports multiple providers and models. Use \
  \`opencode models\` to list available options in provider/model format.
- Paperclip requires an explicit \`model\` value for \`opencode_local\` agents.
- Runs are executed with: opencode run --format json ...
- Sessions are resumed with --session when stored session cwd matches current cwd.
- The adapter sets OPENCODE_DISABLE_PROJECT_CONFIG=true to prevent OpenCode from \
  writing an opencode.json config file into the project working directory. Model \
  selection is passed via the --model CLI flag instead.
- When \`dangerouslySkipPermissions\` is enabled, Paperclip injects a temporary \
  runtime config with \`permission.external_directory=allow\` so headless runs do \
  not stall on approval prompts.
`;
