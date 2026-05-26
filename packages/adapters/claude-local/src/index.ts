import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "claude_local";
export const label = "Claude Code (local)";

export const SANDBOX_INSTALL_COMMAND = "npm install -g @anthropic-ai/claude-code";

export const models = [
  { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-6", label: "Claude Haiku 4.6" },
  { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
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
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file injected at runtime
- model (string, optional): Claude model id
- effort (string, optional): reasoning effort passed via --effort (low|medium|high)
- chrome (boolean, optional): pass --chrome when running Claude
- promptTemplate (string, optional): run prompt template
- maxTurnsPerRun (number, optional): max turns for one run
- dangerouslySkipPermissions (boolean, optional, default true): pass --dangerously-skip-permissions to claude; defaults to true because Paperclip runs Claude in headless --print mode where interactive permission prompts cannot be answered
- enableGoogleWorkspaceMcp (boolean, optional, default true): when true, Paperclip injects a run-scoped Google Workspace MCP config using the company's connector OAuth token
- googleWorkspaceMcpUrl (string, optional): Google Workspace MCP endpoint URL (defaults to GOOGLE_WORKSPACE_MCP_URL or http://localhost:8080/mcp)
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

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- When Paperclip realizes a workspace/runtime for a run, it injects PAPERCLIP_WORKSPACE_* and PAPERCLIP_RUNTIME_* env vars for agent-side tooling.
`;
