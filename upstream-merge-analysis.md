# Upstream merge analysis — `feature/experimentation` → `paperclipai/paperclip` `v2026.722.0`

Branch: `merge/upstream-v2026.722.0` (cut from `feature/experimentation`, which is untouched).
Merge state: `git merge v2026.722.0` in progress, unresolved, nothing committed. This document is analysis only — no conflicts have been resolved.

---

## 1. What's new upstream

### 1.1 In the release itself — `v2026.722.0` (2026-07-22, 44 commits / 13 contributors)

**What a Paperclip user would notice:**

- **Agents can pull their own secrets on demand.** Previously secrets only reached an agent's process via ambient env injection at spawn time. Now there's a run-bound API — `GET /api/agents/me/secrets` (lists granted aliases) and `POST /api/agents/me/secrets/:key/value` (returns the value, `Cache-Control: no-store`) — plus a new **Secret access** editor in agent settings for granting per-agent access. Every read is logged to both the security audit trail and the operator activity log; low-trust review/skill-test tokens are still denied.
- **Local agents (Claude, Codex, Gemini, custom ACP adapters) run natively on Windows**, not just Linux — the ACPX engine dropped its generated-Bash-script wrapper in favor of native process spawning with env injected through ACPX session options.
- **Slash-named secrets browse as folders**, secret access grants use a searchable agent picker instead of a flat list, and external-object labels/star controls were visually decluttered.

**Experimental (behind the Apps flag) — worth flagging up front, this is the seed of a much bigger thing:**
- **"Connections v3" foundation** — a new schema core (stable per-company connection UID, explicit ownership/auth/transport fields, a subject-aware `connection_grants` table, multi-key credentials, `remote_http` renamed to `mcp_remote`), a generated **AppDefinition** catalog for browse/setup, and a runtime layer with subject-aware authorization and OpenAPI-registered grant routes that fail closed on unknown scopes. This is upstream's own answer to "let agents talk to connected external services" — see §3.3, it's the thing that collides hardest with what this fork built independently.

**Fixes worth knowing about:**
- Execution-policy final-stage approval now actually terminates the policy (previously rewound to stage 1).
- Archived inbox items stay archived; run-authored comments no longer 500 on `createdByRunId`; releasing an issue no longer clobbers a terminal status; invalid config files fail loudly instead of being silently ignored; HTTP cookies are redacted from server logs.

**Adapter/execution/heartbeat/plugin/skill surface — nothing in the tagged release itself.** The `PAPERCLIP_*` env-binding fix (see below) and the two Connections-v3 migrations are the only heartbeat/schema-adjacent items, and both landed in the *next* commit wave, not in this tag. The tag is otherwise light on that surface — it gets hit hard in the unreleased commits (next section).

### 1.2 Unreleased on `master` (295 commits, 2026-07-22 → 2026-08-07) — the notable ones

This is not a changelog-quality release yet (no `releases/*.md` entry exists for it), so treat this as "what's coming," not "what shipped." Grouped by what you'll actually feel:

**Adapter layer**
- Windows/Daytona ACP execution matured further: session output now streams live from Daytona sandboxes instead of being polled from the host (#11049); ACPX gained per-adapter managed-home seeding + Codex auth copy-back for the remote ACP lane, workspace staging with in-sandbox cwd routing, and "stage once per remote session, reuse on resume" semantics (#10089, #10070, #10073) — i.e. remote/sandboxed agent execution got materially faster and more stateful.
- `adapter-utils`: provider-delegable `syncIn` with ordered post-upload commands, content-hash-skip on session writes, parallelized Daytona bridge setup, sandbox proxy socket path-length fix for Linux.
- Claude Sonnet 5 and Opus 5 added to the static model fallback list; Codex GPT-5.6 model metadata resolved at source.

**Execution policy / workspace**
- Explicit review-verdict policies added server-side (#10931); execution-policy decision comments clarified (#9105); execution workspaces self-heal when their recorded branch no longer exists (#10578); shared-workspace concurrency is now configurable with a policy-editor control (#10771, #10759).
- `workspace-runtime` picked up a parallel "dev/long-running service" health-check generalization (`isPaperclipDevRuntimeService`, service readiness decoupled from heartbeat run lifecycle) — this is the file that conflicts hardest against this fork's own preview-runtime work; see §3.4.

**Heartbeat** — this is the single most-rewritten file upstream (8,111 insertions / 816 deletions since the merge-base — essentially a different file by volume). Highlights: atomic timer-interval claiming, shared-workspace run serialization with bounded busy-deferrals, cache-adjusted run-cost exposure, hot-restart shutdown-snapshot preservation, low-trust runtime containment, trust-preset resolution, "effective run config" fingerprinting, managed-git-worktree branch coherence checks with auto-repair on finalize, and — the part that matters most for this merge — a generalized **managed MCP** system (`buildPaperclipRuntimeMcpServers`, `createManagedMcpRunConfig`, `createAdapterRuntimeMcpAccess`) that threads MCP server access into every adapter run through a server-owned config rather than per-connector code in heartbeat itself. See §3.5.
- Also: the `PAPERCLIP_*` env-binding fix mentioned in the release notes landed for real in this wave — only `PAPERCLIP_API_KEY` is now rejected, every other `PAPERCLIP_*`-named binding flows through.

**Plugins**
- A **`ToolGatewayService`** (new: `routes/tool-gateway.ts`, `services/tool-gateway.ts`, `mcpGatewayProtocolRoutes`) landed as upstream's generalized tool-dispatch layer, sitting alongside (and eventually presumably replacing) the plain `PluginToolDispatcher`. This is the same problem this fork solved with its own `UnifiedToolDispatcher` — see §3.3.
- Bundled Daytona plugin got a persistent session model with plain command dispatch and live log streaming; managed bundled plugin workers now recover on demand; plugin RPC timeouts are now honored explicitly; proactive-worker company-scope resolution and cross-tenant config-delivery bugs were fixed.

**Skills**
- Skill installs now require explicit merge modes (#10978); an MCP-integration-preparation skill and a beta-release channel for the core Paperclip skill were added; skill imports can browse project folders; managed skill rename API added; audit actor now threads into skip-user-secret skill routes.

**Everything else, briefly:** a large decisions/queue/desk-triage subsystem (propose mode, retention, prioritized attention feed), a two-tier audit/activity feed merge, cross-issue and cross-task agent side-effect containment with attribution/denial UI, a CLI with managed install/update/service lifecycle, OpenTelemetry spans threaded through most of the sandbox startup path, and a chat-style task UI behind an experimental flag (shipped in #10707, then partially reverted in #11067 — see §3.6, this one also collides with the fork).

---

## 2. The shape of the divergence, overall

49 fork-only commits vs. 753 upstream-only commits since the common ancestor (`eb452fb`, upstream's `v2026.722.0` is 295 commits past that ancestor's nearest tag on top of that). The fork's commits are concentrated and additive (chat, connectors, a rebrand, a preview-runtime proxy); upstream's are a near-total rewrite of the run-execution core (heartbeat, workspace-runtime, company-skills, plugin dispatch) plus dozens of new route modules. The result: **41 files conflict, but they fall into distinctly different categories of difficulty.** Roughly:

| Cluster | Files | Nature |
|---|---|---|
| Barrel/list-append collisions | 6 | Mechanical — both sides appended to the same export/route list |
| Rebrand vs. upstream rewrite | ~10–12 | Mechanical but repetitive — re-apply a string swap against upstream's new text |
| Same bug, two fixes | 3 (+1 add/add test file) | Low risk, needs a pick — both sides independently fixed the identical issue |
| Migration numbering | 1 (+journal) | Mechanical once understood — no table/column overlap, pure index collision |
| Genuine architectural collisions | ~6 | Real design decisions — see §3.3–3.6 |
| Large files, not yet individually triaged | ~10 | Substantial diffs on both sides (CompanySkills, Inbox, AgentDetail, IssueDetail, Search, etc.) — sampled but not read in full; see caveat below |

**Caveat on the "not yet individually triaged" row:** given the volume, I opened and read a representative file in each size/symmetry bucket rather than all 41. Files with near-identical insertion/deletion counts on our side (e.g. `ProjectProperties.tsx` 2/2, `SidebarAccountMenu.tsx` 2/2, `InviteLanding.tsx` 11/11) match the confirmed rebrand-pass signature closely enough that I'm treating them as the same category, but I have not opened each one individually to confirm. Everything reported below as a genuine architectural collision, I did open and read.

---

## 3. Cluster-by-cluster

### 3.1 Mechanical — barrel/list-append (trivial)

`server/src/routes/index.ts`, `packages/shared/src/index.ts`, `packages/shared/src/validators/index.ts`, `packages/db/src/schema/index.ts`, `ui/src/App.tsx`, `ui/src/components/CompanySettingsSidebar.tsx`.

Both sides only ever *added new lines* to the same list — new route exports, new schema exports, new validator exports, new top-level UI routes (fork added `Connectors`, `CeoChat`, a standalone `Login` page), a new settings-sidebar nav item pairing with the fork's Connectors route. Git flags these as conflicts purely because both edits landed in the same list at/near the same position; there's no logical incompatibility, just take the union. Genuinely trivial — the only judgment call is ordering, which doesn't matter here.

`server/src/routes/index.ts` upstream diff also drops in `cloudUpstreamRoutes` (from their new `0089_cloud_upstreams.sql`), unrelated to anything in the fork — no interaction.

### 3.2 Mechanical but repetitive — the "Paperclip → Agent Studio" rebrand

This fork carries a whitelabel: `ui/index.html` (`<title>`, `apple-mobile-web-app-title`, favicon links, **and** a default-theme flip from dark to light), `ui/src/pages/CliAuth.tsx`, `ui/src/components/agent-config-primitives.tsx` (confirmed by direct read — the diff is *purely* `"Paperclip"` → `"Agent Studio"` in help-text strings), plus a large `ui/src/index.css` addition (367 lines in one hunk) that reads as the accompanying design-token/theme work for the rebrand rather than a copy tweak.

Every file in this bucket collides because upstream *also* touched the exact same lines — rewriting the surrounding feature, not the brand string — in the 295-commit wave. The fix pattern is identical every time: take upstream's rewritten line, re-apply the fork's string substitution inside it. Individually trivial, but there are a dozen-plus of them and each needs a human (or scripted) pass rather than a blind `git checkout --theirs`, or the rebrand silently regresses file-by-file.

**Not rebrand, despite living in the same size bucket — flagging so it doesn't get steamrolled by a "just resolve the rebrand ones" pass:**
- `ui/src/context/ToastContext.tsx` / `ui/src/components/ToastViewport.tsx` — the fork added real toast features: `placement` (top/bottom), `persistent` toasts that skip the auto-dismiss timer, `isLoading` toasts, and `onClick` actions alongside `href` actions. Upstream also touched these files (23/11 and smaller). Needs an actual merge of two feature sets, not a string re-apply.

### 3.3 Same bug, two independent fixes

`server/src/services/companies.ts` + the add/add `server/src/__tests__/companies-service.test.ts`: both sides independently fixed the same problem — detecting a Postgres unique-constraint violation on `companies_issue_prefix_idx` buried inside a wrapped/caused error, so issue-prefix generation can retry with a suffix. The fork's version walks an error-chain iterator checking `code`/`constraint`/`constraint_name`/`message` fields; upstream's walks the `cause` chain with a `Set`-based cycle guard checking `code`/`constraint`/`constraint_name`. Functionally equivalent, structurally different. The test files reflect the same split: the fork wrote one targeted test; upstream wrote eleven, covering the same fix plus the archive/reactivate cascade behavior around it. This is low-risk to resolve (pick upstream's — it's the more thorough implementation and its test suite is a superset in spirit) but it's a genuine two-implementations-of-one-fix collision, not a list-append.

`server/src/services/company-skills.ts`: same shape, smaller — fork inlined a URL-sniffing predicate (`looksLikeRepoUrl`) for "does this string look like a git repo import source"; upstream extracted the identical logic into a named helper `isGitRepoSkillImportSource`. The single conflicting line is trivial, but it sits inside a file upstream rewrote by 4,508/465 lines — the surrounding context this hunk needs to land in is close to unrecognizable versus what the fork last saw it as.

### 3.4 Genuine architectural collision — dev/preview service health-checking

`server/src/services/workspace-runtime.ts` (fork: +129/-8 vs. upstream: +2,256/-143, six conflicting hunks). The fork built a **preview-lease system**: `isLocalPortListening` (raw TCP probe), `attachPaperclipPreviewLease`, and a `paperclipPreview` flag on the service's `stopPolicy` that changes how health is checked — this is the backing implementation for the "local runtime preview proxy" feature (the fork's most recent commit, and matched by `packages/shared`'s `createPreviewLeaseSchema` export and the fork's own `0088_solid_freak.sql` migration creating a `preview_leases` table).

Upstream built, in parallel, a **generalized dev-runtime-service classifier**: `isPaperclipDevRuntimeService` (detects "this is a Paperclip dev server" from service name/command), `isRuntimeServiceUrlHealthy`, and explicitly decouples manually-controlled services from the heartbeat-run lifecycle so they don't get torn down when a run ends.

Both are solving "how do we know a long-running preview/dev service is actually up" for what looks like the same underlying feature area, with incompatible mechanisms (raw port probe + lease record vs. URL health check + service classification). This needs a design call: which health-check model wins, and does the fork's `preview_leases` table concept survive, get replaced, or get merged into upstream's runtime-service model.

### 3.5 Genuine architectural collision — MCP tool access for agents (the big one)

This spans three files and is the same fight happening in three places at once:

- **`packages/adapters/claude-local/src/server/execute.ts`** (fork +243/0, upstream +340/-41, four hunks) and **`.../claude-local/src/index.ts`** — the fork built per-connector MCP injection directly into the Claude adapter: a `ClaudeGoogleWorkspaceMcpConfig` interface, `runScopedMcpServers` built from whatever connector configs got resolved, `mcpConfigPathsForArgs` written out and passed via `--mcp-config`. Upstream instead generalized: `runtimeMcpServers` resolved once centrally and passed down as `effectiveMcpConfigPath`, plus (unrelated but touching the same code path) a permissions change — remote execution targets now get a curated `--allowedTools` list instead of inheriting the local `--dangerously-skip-permissions` bypass.
- **`server/src/services/heartbeat.ts`** — the fork resolves and injects MCP config for four specific integrations *inline in heartbeat* (Google Workspace, Jira, GitHub, Meta Ads — each with its own connector lookup, credential resolution, and MCP server-config shape), plus injects `PAPERCLIP_API_KEY` into `adapter.adapterConfig.env` for every adapter type so in-process API calls work. Upstream replaced the equivalent surface with a generalized, server-owned pipeline: `buildPaperclipRuntimeMcpServers` → `createAdapterRuntimeMcpAccess` → passed into `adapter.execute()` as `runtimeMcp`, plus a separate `createManagedMcpRunConfig` for managed MCP, plus (in the same hunk) a substantial workspace-finalize/branch-coherence system that has nothing to do with MCP but landed in the exact same region of the function.
- **`packages/adapter-utils/src/server-utils.ts`** (fork +77/-7, upstream +1,230/-87, seven hunks) — the wake-payload normalizer. The fork added a `chat` scope to the payload (`normalizePaperclipWakeChat` — session id/message/truncation, for `ceo_chat`-sourced heartbeats). Upstream added a `recovery` scope (`normalizePaperclipWakeRecovery` — cause, failure summary, original assignee, attempt/max-attempt counts, routing-fallback reason) plus checkbox-selection and execution-workspace normalization, and rewrote the heartbeat-prompt scope-line/execution-contract text blocks that both sides also touch.
- **`server/src/routes/plugins.ts`** — the dispatch-layer expression of the same split. The fork introduced a `UnifiedToolDispatcher` that wraps the existing `PluginToolDispatcher` behind a shared interface alongside a new `ConnectorToolDispatcher` (`connector-tool-dispatcher.ts`, wired in `app.ts` alongside new `/connectors`, `/agents/:agentId/connector-credentials/:type`, `/chat`, and `/preview` routes). Upstream introduced its own generalized layer, `ToolGatewayService` (`ToolGatewayHttpError`, `mcpGatewayProtocolRoutes`), backed by an entirely different schema surface — `0148_tool_access_mcp_connections.sql` through `0169_...rate_limit_counters.sql`, i.e. ~20 migrations' worth of gateway/session/rate-limit infrastructure — and, per the release notes, the "Connections v3" experimental foundation (§1.1) is clearly the long-term home for this.

**The actual decision here isn't a merge-conflict resolution, it's an architecture choice**: does this fork's connector/chat/preview surface get rebuilt on top of upstream's `ToolGatewayService` + Connections v3 + `runtimeMcp` plumbing, or does upstream's tool-gateway get treated as parallel infrastructure the fork's dispatcher sits beside? Either is viable, but picking wrong means re-doing this work later. I'd treat this as the one cluster genuinely worth a design conversation before touching any code, since it's exactly the adapter/execution/heartbeat/plugin surface you flagged.

### 3.6 Genuine architectural collision — onboarding, and a UI restructure in general

`ui/src/components/OnboardingWizard.tsx`: fork +1,036/-32, upstream +810/-348, nine conflicting hunks — the largest single-file conflict by insertion count on either side. The fork substantially expanded the onboarding wizard (new imports, ~730 new lines in one hunk alone starting around the component body). Upstream did something similar and then partially backed out of it: commit `11e56654` *"port onboarding flow from prototype; add cloud + local variants"* (#10786) landed mid-wave, then `384e5f61` *"revert(ui): back out onboarding port"* (#11067) is the very tip of `master`. Both sides independently decided the onboarding flow needed a rewrite, in the same window, with different results — and upstream's own attempt didn't stick. This needs a decision on which onboarding design to keep, not a line-by-line reconciliation; picking either "ours" or "theirs" wholesale would very plausibly break the flow either way given upstream's own back-and-forth on it.

`ui/src/components/SidebarAgents.tsx` (fork +89/-13, upstream +353/-63, three hunks): fork restructured agent rendering to group by category (visible groups like `"Market Signals Research"` — looks like company-specific taxonomy from a specific fork use case). Upstream restructured the same render function for live-status "lingering" (agents that just went live stay visually flagged for a beat) and starred-agent sorting/dedup against the full agent list. Same function, two different reasons to touch it — needs someone who knows whether the fork's grouping feature is still wanted before deciding how to layer it on top of upstream's starred/live-status logic.

`ui/src/pages/IssueDetail.tsx` (fork +102/-168, upstream +1,232/-271, seven hunks): net *removal* on the fork's side (166 more deletions than insertions) suggests a deliberate simplification/feature-removal pass rather than pure rebrand — I did not trace exactly what was removed and why; worth checking before assuming upstream's version can just be re-diffed against it.

### 3.7 Migrations — mechanical once understood, but don't guess at the fix

`packages/db/src/migrations/meta/_journal.json` conflicts starting at index 85, because **both sides used index `0085` for an unrelated migration**:

- **Fork's `0085_create_chat_tables.sql`** — creates `chat_sessions` (id, company_id, title, status, timestamps, FK to `companies`) and `chat_messages` (id, session_id, role, content, metadata, timestamp, FK to `chat_sessions`). Backs the fork's `CeoChat` page and `chatRoutes`.
- **Upstream's `0085_tranquil_the_executioner.sql`** — adds `locked_at`, `locked_by_agent_id`, `locked_by_user_id` columns to the existing `documents` table, with FKs to `agents`/users. A document-locking feature, unrelated to chat.

**No table or column overlap between the two** — I diffed both files directly. The collision is purely numeric: both migrations claim index 85, and Drizzle's journal (`_journal.json`) records `when`/`tag`/`idx` per migration in a strict sequence it uses to apply and verify migrations in order. Beyond `0085`, the fork has exactly two more local migrations — `0087_company_research_sources.sql` (adds `website`, `important_links` columns to `companies`) and `0088_solid_freak.sql` (creates the `preview_leases` table backing §3.4). Upstream, over the same window, added **95 migrations** (`0085` through `0183`, ending with the two additive Connections-v3 migrations called out in the release upgrade guide).

**The actual options:**

1. **Renumber the fork's three migrations to sit after upstream's, e.g. `0184`, `0185`, `0186`.** Regenerate their `_journal.json` entries (new `idx`/`when` timestamps) via `drizzle-kit`, appended after `0183`. This is the low-risk option — it's a pure sequence shift, the SQL bodies don't need to change since there's no table/column overlap, and it matches how migration tools expect a fork to reconcile (their history is authoritative once you're merging into it). **What could break:** if any other fork-only code path assumes migration index 85–88 specifically (e.g. hardcoded in a test, a rollback script, or documentation), it'd need updating too — I didn't find any such reference in the conflict set, but I also didn't do an exhaustive repo-wide search for it.
2. **Rebase upstream's 95 migrations to start after the fork's `0088`.** Technically possible but there's no reason to prefer it — it means renumbering 95 files instead of 3, and it fights the direction data actually flows (this fork is catching up to upstream, not the other way around). I'd only consider this if upstream's migration *tooling itself* (not just the SQL files) has some external dependency on exact index numbers that I haven't seen.
3. **Leave both at `0085` and manually splice `_journal.json`.** Don't do this — Drizzle's journal format doesn't support two entries at the same `idx`, and even if you hand-edited around it, the migration runner applies by journal order; a genuine duplicate index is asking for undefined behavior on whichever environment applies migrations from a partial history.

Recommendation would be option 1, but I'm not applying it — it's a decision worth having someone sign off on given it touches the migration history that every environment running this fork has presumably already applied through `0088`.

---

## 4. Build status

Not attempted, and can't be meaningfully attempted yet — 41 files still contain live `<<<<<<<`/`=======`/`>>>>>>>` markers, so nothing compiles in the current tree.

## 5. Where things stand

- `feature/experimentation` — untouched (verified at `bb716b0e034a78b9c8e48fbb2abd3677711789c3` both before and after this analysis).
- `merge/upstream-v2026.722.0` — merge in progress, 41 files conflicted, nothing resolved, nothing committed. Safe to inspect (`git status`, `git diff`) or abort (`git merge --abort`) without affecting anything else.

Nothing in this document has been acted on — it's read-only analysis per your instruction.
