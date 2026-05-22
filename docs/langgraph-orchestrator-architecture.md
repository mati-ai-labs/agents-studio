# LangGraph Orchestrator — Architecture Spec v2.0

**Version:** 2.0 | **Date:** 2026-05-22 | **Status:** Draft for Implementation

---

## 1. Overview

The LangGraph Orchestrator replaces the CEO agent wake-up flow in the CEO Chat (`/{companyPrefix}/chat`). Instead of waking the CEO agent directly, messages route to a LangGraph agent that:

1. Receives the user message in a chat session
2. Has full Paperclip API descriptions as its tools
3. Creates issues, assigns agents, queries status, returns issue links
4. Falls back to CEO if no suitable agent found (CEO can spawn new agents)
5. Maintains session context across messages (up to ~10 message window)

**Runs inside Paperclip server** — Python FastAPI service co-located with Node.js server.

---

## 2. Integration Points

| Component | Location | Role |
|-----------|----------|------|
| `CeoChat.tsx` | `ui/src/pages/CeoChat.tsx` | Existing chat UI — no changes needed |
| `chat.ts` SSE route | `server/src/routes/chat.ts` | Routes messages to LangGraph instead of CEO wakeup |
| `issueService` | `server/src/services/issues.ts` | Existing — used by LangGraph via internal calls |
| `heartbeatService` | `server/src/services/heartbeat.ts` | Existing — used for agent wakeup |
| LangGraph Python service | `server/src/orchestrator/` | New — runs in-process via Python subprocess or pyodide |

---

## 3. API Surface (Paperclip APIs for LangGraph)

These are the Paperclip API endpoints LangGraph uses as tools:

### Issues
- `POST /api/companies/:companyId/issues` — create issue
- `PATCH /api/issues/:id` with `assigneeAgentId` — assign agent (auto-wakes the agent)
- `GET /api/issues/:id` — get issue status
- `GET /api/issues/:id/comments` — get issue history

### Agents
- `GET /api/companies/:companyId/agents` — list all agents (id, name, role)

### Sessions
- `GET /api/chat/sessions/:id` — get session with messages
- `POST /api/chat/sessions/:id/messages` — send message (SSE streaming)

### Issues Link Format
- URL: `/{companyPrefix}/issues/{issueIdentifier}` e.g. `/issues/PAP-3562`
- Identifier format: `PAP-NNNN` (human-readable)
- UUID also accepted

---

## 4. Session Context Continuity

### Constraint
LangGraph can only pass ~10 previous messages per request. Cannot dump full history.

### Storage: `chat_sessions.metadata`
- Store as JSON in existing `chat_sessions.metadata` column (text, no schema change)
- Read/write via `PATCH /api/chat/sessions/:id/context` and `GET /api/chat/sessions/:id/context`

### Session Context Object
```typescript
interface SessionContext {
  sessionId: string;
  companyId: string;
  userId: string;
  // Issues created by the orchestrator in this session
  issueIds: string[];
  focusedIssueId: string | null;
  // Delegation records
  delegations: {
    delegationId: string;
    agentId: string;
    agentName: string;
    issueId: string | null;
    status: "pending" | "completed" | "failed";
    createdAt: string;
    completedAt: string | null;
    summary: string | null;
  }[];
  // For context resumption
  lastHandoffMarkdown: string | null;
  lastHandoffAt: string | null;
  // Cursor for message pagination
  messageCursor: string | null; // last message ID or timestamp
}
```

### Message Window (10-message limit)
- On each request: fetch last 10 messages via cursor-paginated endpoint
- Store `messageCursor` in SessionContext after each request
- Never load all history — always use sliding window

### Resumption ("what happened with that issue?")
1. Load `SessionContext` from `chat_sessions.metadata`
2. Load last 10 messages via cursor
3. Check delegation status for relevant issue IDs
4. Synthesize: "You created issue PAP-3562 for market research. Market Research Agent completed it at 3pm — summary: ..."

---

## 5. LangGraph Agent Graph Design

### State Schema
```python
class OrchestratorState(TypedDict):
    messages: List[Dict[str, Any]]           # Last ~10 messages
    current_message: str
    session_id: str
    company_id: str
    user_id: str
    session_context: SessionContext         # From chat_sessions.metadata
    intent: str                             # "create_issue" | "assign_agent" | "query_status" | "direct_answer"
    selected_agent_id: str | None
    selected_issue_id: str | None
    delegation_result: dict | None
    response_text: str | None
```

### Nodes
1. **router** — classify intent from user message
2. **fetch_agents** — call `GET /api/companies/:companyId/agents` if agent selection needed
3. **create_issue** — call `POST /api/companies/:companyId/issues`
4. **assign_agent** — call `PATCH /api/issues/:id` with `assigneeAgentId`
5. **query_issue** — call `GET /api/issues/:id` and `GET /api/issues/:id/comments`
6. **delegate_to_ceo** — fallback when no suitable agent found; uses `heartbeatService.wakeup()` internally
7. **respond** — format final response with issue link, status, etc.

### Flow
```
START → router
  ├── "create_issue" → create_issue → respond
  ├── "assign_agent" → fetch_agents → assign_agent → respond
  ├── "query_status" → query_issue → respond
  └── "direct_answer" → respond (no API call)
```

### Checkpointer
- LangGraph in-process checkpointer (PostgreSQL-backed)
- Key: `session_id`

---

## 6. Delegation Flow (Assigning an Agent to an Issue)

When LangGraph assigns an agent:

```
1. PATCH /api/issues/:id
   Body: { "assigneeAgentId": "agent-uuid" }

2. Paperclip updates issue.assigneeAgentId

3. Paperclip automatically wakes the assigned agent via queueIssueAssignmentWakeup

4. Delegation record stored in SessionContext:
   {
     "delegationId": "uuid",
     "agentId": "agent-uuid",
     "agentName": "Market Research Agent",
     "issueId": "issue-uuid",
     "status": "pending",
     "createdAt": "ISO timestamp"
   }

5. Response to user:
   "Created issue PAP-3562 and assigned Market Research Agent.
    Track progress: /{companyPrefix}/issues/PAP-3562"
```

### CEO Fallback
When no suitable agent found, LangGraph assigns to CEO:
- `PATCH /api/issues/:id` with `assigneeAgentId: CEO_AGENT_ID`
- CEO can create new agents via Paperclip's agent creation API

---

## 7. What to Build

### Phase 1: Core (do first)
1. **LangGraph agent service** — Python FastAPI inside `server/src/orchestrator/`
   - Graph definition (router, create_issue, assign_agent, query_issue, respond)
   - Paperclip API client (calls existing endpoints)
   - SessionContextManager (reads/writes `chat_sessions.metadata`)
   - In-process checkpointer

2. **Route change in `chat.ts`** — instead of `heartbeat.wakeup(ceoAgentId, ...)`:
   - Call LangGraph agent with the message
   - Stream response back via SSE (same pattern as existing CEO chat)
   - Update SessionContext after each interaction

3. **Context endpoints** (extend `chat.ts`):
   - `GET /api/chat/sessions/:id/context` — return SessionContext
   - `PATCH /api/chat/sessions/:id/context` — update SessionContext (partial merge)

### Phase 2: Polish
4. **Issue link generation** — LangGraph returns deterministic URLs
5. **Delegation status tracking** — poll or webhook for run completion
6. **CEO fallback** — detect no suitable agent → assign to CEO

---

## 8. Example Interactions

### User: "Do market research on competitor X"
```
Router → intent: "create_issue"
FetchAgents → finds "market-research-agent"
create_issue → POST /api/companies/:companyId/issues
  → { title: "Market research: competitor X", description: "..." }
  → returns { id: "uuid", identifier: "PAP-3562" }
assign_agent → PATCH /api/issues/:uuid
  → { assigneeAgentId: "market-research-agent-uuid" }
  → Paperclip auto-wakes the agent
respond → "Created issue PAP-3562 and assigned Market Research Agent.
  Track it: /{companyPrefix}/issues/PAP-3562"
Store delegation in SessionContext
```

### User: "What's the status of that market research?"
```
Router → intent: "query_status"
query_issue → GET /api/issues/uuid
  → { status: "completed", resultJson: { summary: "..." } }
query_issue_comments → GET /api/issues/uuid/comments
respond → "Market research on competitor X is done. Summary: ...
  Full report: /{companyPrefix}/issues/PAP-3562"
```

### User: "Build a landing page for my product"
```
Router → intent: "create_issue"
FetchAgents → finds "website-builder-agent"
create_issue → creates issue
assign_agent → assigns website-builder-agent
respond → "Created issue PAP-3563 and assigned Website Builder Agent.
  Track it: /{companyPrefix}/issues/PAP-3563"
```

### User: "Do something I haven't specified"
```
Router → intent: "direct_answer" (or falls back to CEO)
respond → "I can help you with: creating issues, assigning agents,
  tracking progress, market research, website building...
  What would you like to do?"
```

---

## 9. Key Files

| File | Purpose |
|------|---------|
| `server/src/orchestrator/` | New Python FastAPI service (LangGraph agent) |
| `server/src/orchestrator/graph.py` | LangGraph state + node definitions |
| `server/src/orchestrator/paperclip_client.py` | Paperclip API client |
| `server/src/orchestrator/session_context.py` | SessionContextManager |
| `server/src/routes/chat.ts` | Modify: call LangGraph instead of CEO wakeup |
| `server/src/routes/chat-context.ts` | New: GET/PATCH /api/chat/sessions/:id/context |
| `server/src/onboarding-assets/ceo/TOOLS.md` | Update with API tool descriptions |

---

## 10. Out of Scope (Don't Build)
- New internal delegate endpoint — `PATCH /issues/:id` with `assigneeAgentId` already exists and auto-wakes agents
- Custom checkout model — Paperclip handles this internally
- Separate webhook endpoint for run completion — LangGraph polls if needed or uses existing heartbeat events
- Changing any existing Paperclip UI or internal service architecture