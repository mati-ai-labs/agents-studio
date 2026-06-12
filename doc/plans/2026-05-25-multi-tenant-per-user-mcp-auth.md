# Multi-Tenant Per-User MCP Auth Architecture

**Date:** 2025-05-25  
**Status:** Draft  
**Scope:** V1 connector auth — Google Workspace, Notion, Linear  

---

## Problem Statement

Paperclip stores per-company OAuth tokens in Postgres (`company_connectors.credentials_encrypted`), keyed by `companyId`. When an agent runs via Claude Code, MCP servers (Google Workspace MCP, MiniMax MCP, and `@paperclipai/mcp-server`) read auth tokens from **static config** (env vars, config files). This means **all users share the same token**, even though Paperclip has per-company credentials.

Current flow (broken for multi-tenant):

```
User A (company A) → Paperclip → spawn Claude Code → calls Google Workspace MCP
                                                              └→ uses hardcoded token (same for ALL users)
```

Desired flow:

```
User A (company A) → Paperclip → spawn Claude Code → calls @paperclipai/mcp-server tool
                                                              └→ Paperclip server resolves User A's OAuth token
                                                                 → calls Google API with User A's token
```

---

## Current Architecture

### What Already Works

1. **`connector-registry.ts`** — Stores encrypted OAuth credentials per `(companyId, connectorType)`. Decrypts on demand.

2. **`connector-tools.ts`** — 13 connector tool implementations (Gmail send/read, Calendar list/create, Drive list, Notion search/get/create, Linear issues/create). Each function takes `(db: Db, input: { companyId, args })` and fetches credentials from the registry.

3. **`connector-tool-dispatcher.ts`** — Registers connector tools under namespaced names (`google_workspace:gmail_send`, etc.) and dispatches execution with `companyId`.

4. **`unified-tool-dispatcher.ts`** — Combines `PluginToolDispatcher` + `ConnectorToolDispatcher`. Routes `connector:*` tools to the connector dispatcher, falling back to plugin dispatcher.

5. **`@paperclipai/mcp-server`** — Paperclip's MCP server exposes connector tools as MCP-native tools. These call `POST /api/plugins/tools/execute` via `PaperclipApiClient`, which routes through the unified dispatcher.

6. **`POST /api/plugins/tools/execute`** — Route handler that validates `runContext.companyId` and delegates to `unifiedToolDispatcher.executeTool()`.

### What's Missing: Per-Company Auth Injection

The MCP server currently sends a **static `companyId`** (from `PAPERCLIP_COMPANY_ID` env var) rather than resolving it per-request. The `PaperclipApiClient` defaults:

```ts
// packages/mcp-server/src/config.ts
export interface PaperclipMcpConfig {
  apiUrl: string;
  apiKey: string;
  companyId: string | null;  // ← static, set once at startup
  agentId: string | null;
  runId: string | null;
}
```

When Claude Code calls a connector tool, `buildConnectorToolExecuteParams` in `tools.ts` uses:

```ts
const resolvedCompanyId = (companyId as string | undefined) || client.defaults.companyId;
```

If Claude Code doesn't pass `companyId`, it falls back to the static env var. This is the core problem: the MCP server has no way to know _which company's_ credentials to use for a given request.

---

## Architecture Options

### Option A: Paperclip MCP Server as Gateway (Recommended) ✅

**Principle:** Route all connector tool calls through `@paperclipai/mcp-server`, which proxies to Paperclip's unified tool dispatcher, which resolves per-company credentials server-side.

**How it works:**

1. Claude Code is configured to use `@paperclipai/mcp-server` as the MCP server for all connector tools.
2. When Paperclip spawns Claude Code, it sets `PAPERCLIP_COMPANY_ID` in the env, so the MCP server already knows the company.
3. The MCP server's connector tools already call `POST /api/plugins/tools/execute` with `{ tool, parameters, runContext }`, and the `runContext.companyId` is populated from the env default.
4. The server-side unified dispatcher resolves credentials from the DB per `companyId`.

**Changes needed:**

| Component | Change |
|---|---|
| `packages/mcp-server/src/tools.ts` | Remove `companyId` from connector tool schemas (it's auto-resolved from env). Ensure `buildConnectorToolExecuteParams` always uses `client.defaults.companyId`. |
| `packages/mcp-server/src/connector-tools.ts` | Simplify schemas — remove `companyId` as an optional parameter since it's always resolved from the env. |
| `packages/adapters/claude-local` | When Paperclip spawns Claude Code, set `PAPERCLIP_COMPANY_ID` in the process env (already done via `buildPaperclipEnv`). |
| Claude Code config | Configure `@paperclipai/mcp-server` in the Claude Code MCP config. Ensure `PAPERCLIP_COMPANY_ID` and `PAPERCLIP_API_KEY` are in the env. |

**Why this works for multi-tenant:** Each Claude Code process is spawned per-agent-per-run for a specific company. The `PAPERCLIP_COMPANY_ID` is set per invocation, so the MCP server always knows which company's credentials to use.

**Pros:**
- Minimal changes — the infrastructure already exists.
- Credentials never leave Paperclip's server.
- Per-company isolation is enforced naturally (each agent run is scoped to one company).
- No need to inject credentials into Claude Code's MCP config.

**Cons:**
- Requires the Paperclip server to be running and accessible from Claude Code's MCP server process.
- External third-party MCP servers (like the official Google Workspace MCP) cannot be used directly — they must be routed through Paperclip's MCP server.

### Option B: Dynamic Credential Injection into MCP Config

**Principle:** Before spawning Claude Code, dynamically generate MCP server config files with per-company OAuth tokens embedded.

**How it works:**

1. Before spawning Claude Code, Paperclip reads per-company OAuth tokens from the DB.
2. Paperclip writes a `.mcp.json` or `claude.json` file with the tokens embedded.
3. Claude Code reads this config and passes tokens to MCP servers.

**Why we reject this:**

- **Security risk:** OAuth tokens in config files on disk. These are long-lived refresh tokens and access tokens.
- **Token refresh problem:** Access tokens expire. Who refreshes them? The MCP server can't refresh because it doesn't have the refresh token flow. Paperclip's server handles refresh, but the MCP server just has a stale token.
- **Complexity:** Managing config files per company per spawn, cleaning them up, rotating tokens.
- **Third-party MCP compatibility:** Most third-party MCP servers don't accept dynamic auth injection anyway.

### Option C: OAuth Proxy / Token Endpoint

**Principle:** Add a token exchange endpoint to Paperclip's API. MCP servers request a short-lived scoped token from Paperclip instead of using raw OAuth tokens.

**How it works:**

1. Paperclip adds `GET /api/connectors/:type/token` that returns a short-lived company-scoped token.
2. MCP servers are configured with a Paperclip API key (not the OAuth token).
3. Before making API calls, MCP servers call Paperclip's token endpoint to get the current access token for the connector.

**Why this is Option A-plus:**
- This adds indirection. The MCP server might as well just call Paperclip's unified tool dispatcher (Option A), which does the same thing but also handles the API call.
- Only useful if MCP servers _must_ make direct API calls to third parties (e.g., Google Calendar API) — but then they need to handle rate limiting, error formatting, etc., which the server-side connector tools already do.

**Verdict:** Over-engineered for V1. Option A achieves per-company auth without building a token proxy.

---

## Recommended Architecture: Option A (Server-Gateway Pattern)

### Flow Diagram

```
User A (Company A) triggers agent run
  │
  ▼
Paperclip Server
  │ 1. Resolve company, agent, workspace context
  │ 2. Build env: PAPERCLIP_COMPANY_ID=companyA, PAPERCLIP_API_KEY=...
  │
  ▼
spawn Claude Code (with env vars)
  │
  ▼
Claude Code calls MCP tool: google_workspace_gmail_send
  │
  ▼
@paperclipai/mcp-server (stdio process, inherits env)
  │ PAPERCLIP_COMPANY_ID=companyA → client.defaults.companyId
  │
  ▼
POST /api/plugins/tools/execute
  { tool: "google_workspace:gmail_send", parameters: {...}, runContext: { companyId: "companyA", ... } }
  │
  ▼
Unified Tool Dispatcher
  │ Routes to ConnectorToolDispatcher
  │
  ▼
Connector Tool: gworkspace_gmail_send(db, { companyId: "companyA", args: {...} })
  │ 1. connectorRegistryService(db).getCredentialsAsync("companyA", "google_workspace")
  │ 2. Decrypt stored OAuth credentials
  │ 3. Use accessToken to call Gmail API
  │
  ▼
Gmail API (with User A's OAuth token)
```

### Implementation Steps

#### Step 1: Clean up `companyId` handling in MCP server connector tools

**File:** `packages/mcp-server/src/connector-tools.ts`

The current `companyIdOptional` schema parameter is unnecessary for the `@paperclipai/mcp-server` flow because the company is always determined by the env vars. However, keeping it as optional is useful for the `paperclipApiRequest` escape hatch. We should:

1. Make `companyId` non-optional in the MCP schemas but default it from the `PaperclipApiClient` when not provided.
2. Update `buildConnectorToolExecuteParams` to always include `companyId` from `client.defaults.companyId`.

**Changes:**

```ts
// connector-tools.ts - keep companyIdOptional for schema, but always resolve
export const companyIdOptional = z.string().uuid().optional()
  .describe("Company ID. Defaults to the PAPERCLIP_COMPANY_ID of the MCP server. Only needed for multi-company setups.");
```

In `tools.ts`, the `createConnectorToolDefs` function already handles this correctly — it calls `buildConnectorToolExecuteParams` which resolves `companyId` from `client.defaults`. No change needed there.

#### Step 2: Ensure `PAPERCLIP_COMPANY_ID` is set in Claude Code env

**File:** `packages/adapter-utils/src/server-utils.ts`
**File:** `packages/adapters/claude-local/src/server/execute.ts`

Already implemented. `buildPaperclipEnv(agent)` sets:
```ts
PAPERCLIP_COMPANY_ID: agent.companyId,
PAPERCLIP_AGENT_ID: agent.id,
```

And `buildClaudeRuntimeConfig` already includes these in the env passed to the Claude Code subprocess.

#### Step 3: Verify the `runContext` flow from MCP server to unified dispatcher

**File:** `packages/mcp-server/src/tools.ts`

The `buildConnectorToolExecuteParams` function:

```ts
function buildConnectorToolExecuteParams(
  client: PaperclipApiClient,
  toolName: string,
  input: Record<string, unknown>,
): { tool: string; parameters: Record<string, unknown>; runContext: Record<string, unknown> } {
  const { companyId, ...rest } = input;
  const resolvedCompanyId = (companyId as string | undefined) || client.defaults.companyId;

  const parameters: Record<string, unknown> = { ...rest };
  if (resolvedCompanyId) {
    parameters.companyId = resolvedCompanyId;
  }

  return {
    tool: toolName,
    parameters,
    runContext: {
      agentId: client.defaults.agentId ?? "",
      runId: client.defaults.runId ?? "",
      companyId: resolvedCompanyId ?? "",
      projectId: "",
    },
  };
}
```

This correctly resolves `companyId` from the client's defaults (which come from `PAPERCLIP_COMPANY_ID`). ✅ No change needed.

#### Step 4: Handle third-party MCP servers (Google Workspace MCP, MiniMax MCP)

The key insight: **we should NOT use third-party MCP servers directly for connector auth.** Instead, all connector tools should be routed through `@paperclipai/mcp-server`, which proxies to Paperclip's server-side connector execution.

For third-party MCP servers that provide _non-connector_ functionality (e.g., MiniMax for image generation), they can continue to use static config because they don't need per-company auth — they use a single API key.

**Migration path:**

1. **Google Workspace MCP** → Replace with Paperclip's `google_workspace:*` connector tools exposed via `@paperclipai/mcp-server`. Remove Google Workspace MCP from Claude Code's config.
2. **MiniMax MCP** → Keep as-is. MiniMax uses a single company-wide API key, not per-user OAuth.
3. **Notion MCP** → Replace with Paperclip's `notion:*` connector tools. Remove Notion MCP from Claude Code's config.
4. **Linear MCP** → Replace with Paperclip's `linear:*` connector tools. Remove Linear MCP from Claude Code's config.

#### Step 5: Implement OAuth token refresh

Currently, `connector-registry.ts` stores `accessToken`, `refreshToken`, and `expiry`, but `connector-tools.ts` only uses `accessToken` without checking expiry or refreshing.

**File:** `server/src/services/connector-tools.ts`

Add token refresh logic:

```ts
async function gworkspace_get_credentials(db: Db, companyId: string) {
  const registry = connectorRegistryService(db);
  const connector = await registry.getByType(companyId, "google_workspace");
  if (!connector || !connector.credentialsEncrypted) return null;
  
  const creds = decryptCredentials(connector.credentialsEncrypted);
  
  // Check if token is expired and refresh if needed
  if (creds.expiry && creds.expiry < Date.now() / 1000 && creds.refreshToken) {
    const refreshed = await refreshGoogleToken(creds.refreshToken);
    if (refreshed) {
      await registry.upsert({
        companyId,
        type: "google_workspace",
        credentials: {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? creds.refreshToken,
          expiry: refreshed.expiry,
        },
        status: "connected",
      });
      return { ...creds, ...refreshed };
    }
    // If refresh fails, return expired token and let the API call fail naturally
  }
  
  return creds;
}
```

This requires adding refresh token endpoints to the connector routes, but the pattern is straightforward: exchange the refresh token for a new access token, store it, and return it.

#### Step 6: Configure Claude Code to use `@paperclipai/mcp-server`

When Paperclip spawns Claude Code, it should configure the MCP server in the Claude Code config.

**Option A (current):** Users manually configure `.mcp.json` or `claude.json`  

**Option B (recommended):** Paperclip dynamically writes Claude Code config before spawning.

Since the Claude Code adapter already uses `prepareClaudeConfigSeed` to seed auth/config files for remote execution, we can extend this to also seed MCP server configuration.

Add MCP server config to `claude-config.ts`:

```ts
// In the config seed, include MCP server configuration:
{
  "mcpServers": {
    "paperclip": {
      "command": "npx",
      "args": ["-y", "@paperclipai/mcp-server"],
      "env": {
        "PAPERCLIP_API_URL": "<api-url>",
        "PAPERCLIP_API_KEY": "<api-key>",
        "PAPERCLIP_COMPANY_ID": "<company-id>",
        "PAPERCLIP_AGENT_ID": "<agent-id>"
      }
    }
  }
}
```

This ensures that every Claude Code run has access to Paperclip's connector tools with the correct company context.

---

## Security Model

### Per-Company Isolation

- Each Claude Code process is scoped to a single company via `PAPERCLIP_COMPANY_ID`.
- The Paperclip API validates `companyId` against the authenticated agent's company in `POST /api/plugins/tools/execute`.
- OAuth tokens are stored encrypted in the DB and decrypted only on-demand.
- Tokens never appear in Claude Code's config files or env vars directly.

### Attack Surface

- **Agent escape:** If an agent tries to call `google_workspace:gmail_send` with a different `companyId`, the server-side route handler rejects it because `assertCompanyAccess(req, runContext.companyId)` verifies the agent's API key maps to the claimed company.
- **Token leakage:** Tokens are only stored encrypted in the DB, transmitted over HTTPS to the Paperclip API, and used server-side to make API calls. They never reach Claude Code's filesystem or process env.

---

## Connector Tool Naming in MCP

The current MCP tool naming has a redundancy issue. From `createConnectorToolDefs`:

```ts
// "google_workspace" + "google_gmail_send" → "google WorkspaceGmailSend" 
// but the internal tool name sent to the dispatcher is "google_gmail_send"
```

The MCP tool names should match what the agent sees. The naming should be:

| MCP Tool Name (what Claude sees) | Internal Name (what dispatcher routes) |
|---|---|
| `google_gmail_send` | `google_workspace:gmail_send` |
| `google_gmail_read` | `google_workspace:gmail_read` |
| `google_calendar_events` | `google_workspace:calendar_events` |
| `google_calendar_create` | `google_workspace:calendar_create` |
| `google_drive_list` | `google_workspace:drive_list` |
| `notion_search` | `notion:notion_search` |
| `notion_get_page` | `notion:notion_get_page` |
| `notion_create_page` | `notion:notion_create_page` |
| `linear_search_issues` | `linear:linear_issues` |
| `linear_create_issue` | `linear:linear_create_issue` |
| `linear_update_issue` | `linear:linear_update_issue` |
| `linear_list_teams` | `linear:linear_list_teams` |

Wait — there's a naming inconsistency in the unified dispatcher. The connector tool dispatcher uses `{connectorType}:{toolName}` format (e.g., `google_workspace:gmail_send`), but the `CONNECTOR_MCP_TOOLS` in `connector-tools.ts` uses the bare tool name (e.g., `google_gmail_send`).

The `buildConnectorToolExecuteParams` function sends `toolName` as `toolDef.name` (the bare name like `google_gmail_send`), but the unified dispatcher expects the namespaced format (`google_workspace:gmail_send`).

**Bug:** The MCP server sends `tool: "google_gmail_send"` to `POST /plugins/tools/execute`, but the unified dispatcher routes by `connectorToolNames.has(namespacedName)` which checks for `google_workspace:gmail_send`. This would fail!

Let me verify:

```ts
// In unified-tool-dispatcher.ts:
function isConnectorTool(namespacedName: string): boolean {
  return connectorToolNames.has(namespacedName);
}

// In connector-tool-dispatcher.ts:
// Names are registered as "google_workspace:gmail_send", "notion:notion_search", etc.
```

And in `createConnectorToolDefs`:

```ts
return makeTool(
  `${toolDef.connectorType.replace(/_([a-z])/g, (_, c) => c.toUpperCase())}_${toolDef.name.split('_').slice(1).join('_')}`,
  // This generates names like: "googleWorkspace_gmail_send", "notion_search"
  ...
  async (input) => {
    const { tool, parameters, runContext } = buildConnectorToolExecuteParams(client, toolDef.name, input);
    // toolDef.name = "google_gmail_send"
    // This gets sent as { tool: "google_gmail_send", ... } to /plugins/tools/execute
```

This IS a bug. The MCP server sends the bare name like `google_gmail_send`, but the unified dispatcher expects `google_workspace:gmail_send`.

**Fix:** `buildConnectorToolExecuteParams` should compute the namespaced name:

```ts
function buildConnectorToolExecuteParams(
  client: PaperclipApiClient,
  toolDef: ConnectorMcpTool,
  input: Record<string, unknown>,
): { tool: string; parameters: Record<string, unknown>; runContext: Record<string, unknown> } {
  const { companyId, ...rest } = input;
  const resolvedCompanyId = (companyId as string | undefined) || client.defaults.companyId;
  const namespacedName = `${toolDef.connectorType}:${toolDef.name.includes('_') ? toolDef.name.split('_').slice(1).join('_') : toolDef.name}`;

  return {
    tool: namespacedName,
    parameters: { ...rest, ...(resolvedCompanyId ? { companyId: resolvedCompanyId } : {}) },
    runContext: {
      agentId: client.defaults.agentId ?? "",
      runId: client.defaults.runId ?? "",
      companyId: resolvedCompanyId ?? "",
      projectId: "",
    },
  };
}
```

---

## Implementation Checklist

1. ✅ **Verify `PAPERCLIP_COMPANY_ID` flows through Claude Code env** — Already works via `buildPaperclipEnv`.
2. ✅ **Verify MCP server reads `PAPERCLIP_COMPANY_ID` from env** — Already works via `readConfigFromEnv`.
3. ✅ **Verify `POST /plugins/tools/execute` routes to connector dispatcher** — Already works via unified dispatcher.
4. 🔧 **Fix MCP tool name routing bug** — `buildConnectorToolExecuteParams` sends bare names but dispatcher expects namespaced names.
5. 🔧 **Add OAuth token refresh to connector-tools.ts** — Check expiry and refresh tokens before API calls.
6. 🔧 **Seed MCP server config in Claude Code config** — Extend `claude-config.ts` to include `mcpServers` in the seeded config.
7. 🔧 **Remove third-party connector MCP servers from Claude Code config** — For Google Workspace, Notion, Linear, remove direct MCP server configs and route through `@paperclipai/mcp-server`.
8. 🔧 **Add local dev/test for the full flow** — Verify end-to-end: company agent → Claude Code → Paperclip MCP → connector tool → correct OAuth token used.

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Token refresh fails silently | Log refresh errors, return meaningful error to agent, show in connector status UI |
| MCP server startup latency | MCP server is lightweight (stdio), starts in <1s |
| Paperclip server down during MCP call | MCP server returns error, Claude Code retries |
| Backward compat: removing `companyId` from schemas | Keep as optional field, document that it defaults to env var |
| Connector naming inconsistency | Fix the namespaced name mapping in one PR |

---

## Future Enhancements (V2)

1. **Per-user OAuth (not just per-company):** Currently credentials are per-company. If User A and User B are in the same company, they share OAuth credentials. For V2, we could add per-user OAuth with `userId` scoping.

2. **Dynamic MCP tool registration:** Currently MCP tools are static. When a company connects a new connector, the MCP server should advertise new tools dynamically. This requires a tool refresh mechanism.

3. **Connector health checks:** Periodic health checks for connected connectors (token validity, API reachability).

4. **Audit logging:** Log all connector tool invocations with companyId, agentId, tool name, and success/failure.