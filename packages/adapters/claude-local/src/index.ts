import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "claude_local";
export const label = "Claude Code";

export const SANDBOX_INSTALL_COMMAND = "npm install -g @anthropic-ai/claude-code";

export const models = [
  { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
  { id: "claude-fable-5", label: "Claude Fable 5" },
  { id: "claude-mythos-5", label: "Claude Mythos 5" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use Claude Sonnet as the lower-cost Claude Code lane while preserving the agent's primary model.",
    adapterConfig: {
      model: "claude-sonnet-4-6",
      effort: "low",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# claude_local agent configuration

Adapter: claude_local

Core fields:
- engine (string, optional): execution engine. Leave unset/auto to use ACP when prerequisites pass and fall back to the Claude Code CLI with diagnostics. Use "cli" to pin the CLI lane or "acp" to require ACP.
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file injected at runtime
- model (string, optional): Claude model id
- effort (string, optional): reasoning effort passed via --effort (low|medium|high)
- chrome (boolean, optional): pass --chrome when running Claude
- promptTemplate (string, optional): run prompt template
- maxTurnsPerRun (number, optional): max turns for one run
- dangerouslySkipPermissions (boolean, optional, default true): pass --dangerously-skip-permissions to local Claude runs; remote targets receive a curated --allowedTools list so they do not inherit local bypass permissions
- enableGoogleWorkspaceMcp (boolean, optional, default true): when true, Paperclip injects a run-scoped Google Workspace MCP config using the company's connector OAuth token
- googleWorkspaceMcpUrl (string, optional): Google Workspace MCP endpoint URL (defaults to GOOGLE_WORKSPACE_MCP_URL or http://localhost:8000/mcp)
- enableJiraMcp (boolean, optional, default true): when true, Paperclip can inject Jira MCP config when Jira credentials are present in adapter config
- jiraMcpUrl (string, optional): Jira MCP endpoint URL (defaults to JIRA_MCP_URL or http://localhost:8090/mcp)
- jiraMcpServerName (string, optional, default jira): MCP server name key for injected Jira config
- jiraBaseUrl (string, optional): Jira instance URL used for X-Atlassian-Jira-Url header
- jiraPersonalToken (string, optional): token used for X-Atlassian-Jira-Personal-Token header
- enableGithubMcp (boolean, optional, default true): when true, Paperclip can inject GitHub MCP config when a GitHub token is present in adapter config
- githubMcpUrl (string, optional): GitHub MCP endpoint URL (defaults to GITHUB_MCP_URL or https://api.githubcopilot.com/mcp)
- githubMcpServerName (string, optional, default github): MCP server name key for injected GitHub config
- githubMcpAccessToken (string, optional): GitHub token injected as Authorization Bearer for GitHub MCP
- githubPersonalAccessToken (string, optional): alias for githubMcpAccessToken
- githubPat (string, optional): alias for githubMcpAccessToken
- mcpConfigFilePath (string, optional): path to an MCP config JSON file passed directly to Claude via --mcp-config (relative paths resolve from runtime cwd)
- mcpConfigFilePaths (string[], optional): multiple MCP config JSON files passed via repeated --mcp-config flags
- autoWorkspaceJiraMcpConfig (boolean, optional, default true): automatically include .mcp-jira.json from the runtime cwd when present
- command (string, optional): defaults to "claude"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables
- workspaceStrategy (object, optional): execution workspace strategy; currently supports { type: "git_worktree", baseRef?, branchTemplate?, worktreeParentDir? }
- workspaceRuntime (object, optional): reserved for workspace runtime metadata; workspace runtime services are manually controlled from the workspace UI and are not auto-started by heartbeats
- filesystemScope (string, optional): set to "workspace" to confine local CLI filesystem access with Bubblewrap. Off by default. The workspace and Claude config remain writable; other host paths are hidden.
- filesystemExtraPaths (array, optional): additional absolute host paths exposed inside the workspace sandbox. String entries are read-only; object entries use { path: "/absolute/path", access: "ro" | "rw" }.
- filesystemSandboxCommand (string, optional): Bubblewrap executable name or absolute path; defaults to "bwrap". Linux only.
- networkScope (string, optional): "deny" blocks all network egress; "allowlist" permits only networkAllowlist targets through Paperclip's HTTP(S) proxy. Off by default.
- networkAllowlist (string[], optional): exact hostnames, hostname:port entries, or origin URLs. Include the configured Claude provider origin, such as "api.anthropic.com", Bedrock/Vertex endpoints, or a custom gateway.

ACP fields (only when engine="acp"):
- agentCommand (string, optional): override for the Claude ACP server command; defaults to the package-local claude-agent-acp binary
- mode (string, optional, default "persistent"): ACP session mode ("persistent" or "oneshot")
- stateDir (string, optional): ACP session state directory; defaults to Paperclip-managed company/agent scoped storage
- nonInteractivePermissions (string, optional, default "deny"): fallback when the ACP agent asks for input outside an interactive session
- warmHandleIdleMs (number, optional, default 0): keep the ACP process warm for this many ms after a successful run

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- filesystemScope and networkScope are spawn-level confinement and are orthogonal to Claude permission flags. Both require Bubblewrap on the host and select the CLI engine in auto mode; engine="acp" is rejected because ACP confinement is not yet supported. networkScope="allowlist" injects HTTP_PROXY/HTTPS_PROXY for the CLI while its private network namespace blocks direct sockets, so every required provider/API hostname must be listed explicitly.
- The Claude ACP lane requires Node >=22.12.0 and @agentclientprotocol/claude-agent-acp to be installed with this adapter package. Auto engine selection falls back to CLI when those prerequisites are unavailable; explicit engine="acp" fails loudly.
- For ACP runs, model selection is passed through ANTHROPIC_MODEL at ACP server startup; Paperclip-managed Claude permissions and ephemeral skill materialization are handled by the shared ACP engine.
- When Paperclip realizes a workspace/runtime for a run, it injects PAPERCLIP_WORKSPACE_* and PAPERCLIP_RUNTIME_* env vars for agent-side tooling.
`;
