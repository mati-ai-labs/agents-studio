# CEO Orchestrator — Agent Dispatch Fix Spec

## Context
CEO Chat creates issues but assigned agents never get notified/woken up. The dispatch chain is broken.

## Problem 1: Agents never get woken up after being assigned via CEO Chat

**Root cause:** In `chat.ts`, issues are created with `status: "backlog"`. The `queueIssueAssignmentWakeup` function has this guard:
```typescript
if (!input.issue.assigneeAgentId || input.issue.status === "backlog") return;
```
Since issues are always created as `"backlog"`, the wakeup is never triggered.

**Fix:** After creating the issue, immediately update its status to `"todo"`:
```typescript
await issuesSvc.update(createdIssue.id, { status: "todo" });
```
This transition (`backlog → todo`) is allowed by `assertTransition` and will trigger `queueIssueAssignmentWakeup`, which calls `heartbeat.wakeup()` on the assigned agent.

---

## Problem 2: Agent matching only uses `name`, ignores `title` and `capabilities`

**Root cause:** `resolveTargetAgent()` in `chat.ts` only does regex matching on `agent.name`. Fields `title`, `capabilities`, and `role` are completely ignored.

**Fix:** Enhance `resolveTargetAgent` to build a richer agent context and match on:
- `name` (exact/explicit mention)
- `title` (what the agent is for)
- `capabilities` (what it can do)
- `role` (ceo, general, etc.)

New matching strategy:
1. Exact name match via patterns (`\bfor <name>\b`, `\bto <name>\b`, etc.) — highest priority
2. Capability/title semantic match — score each agent by how well their `title` + `capabilities` + `role` matches the user's request
3. Fallback to CEO → first active agent

The matching prompt should include a description of each agent's role and capabilities so it can make a smart decision.

---

## Changes

### File: `server/src/routes/chat.ts`

#### Change A: Status transition to trigger agent wakeup
After:
```typescript
createdIssue = issue;
```
Add:
```typescript
// Transition to todo to trigger the agent wakeup dispatch
await issuesSvc.update(createdIssue.id, { status: "todo" });
```

#### Change B: Enhanced `resolveTargetAgent` function
Replace the current `resolveTargetAgent` with one that matches on name + title + capabilities + role. The function should:
1. Try explicit name/mention patterns first
2. If no explicit match, score all non-CEO agents by comparing the request content against their `title + capabilities + role` combined description
3. Return the best-scoring agent with `matchedBy: "capability_match"` or similar

The scoring can be simple keyword-based (count overlapping terms between request and agent description) or LLM-powered. For now, use keyword/embedding similarity — extract key topic words from the user request, compare against each agent's combined description.

---

## Acceptance Criteria
1. When CEO Chat assigns an issue to a named/explicit agent, that agent is woken up and starts working on it
2. When CEO Chat assigns an issue based on capability matching (without explicit name), the most suitable agent is woken up
3. The "Todo" issue appears in the Issues section and the assigned agent's queue
4. Verified by: CEO Chat → "Do market research on B2B SaaS pricing" → correct agent assigned and woken
