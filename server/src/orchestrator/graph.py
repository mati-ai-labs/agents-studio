"""
Paperclip Orchestrator — LangGraph ReAct agent with async Paperclip tools.

LangGraph IS the agent. We provide typed async tools + a role-defining system
prompt. The LLM decides which tools to call autonomously — no manual LLM
calls inside nodes.

All tools are async to avoid asyncio.run() clashes with FastAPI's event loop.
LangGraph's create_react_agent handles async tools natively.
"""

from __future__ import annotations

import json
import os
from typing import Annotated, NotRequired, Sequence

from langgraph.graph.message import add_messages
from langgraph.checkpoint.memory import MemorySaver
from langgraph.prebuilt import create_react_agent
from langgraph.managed.is_last_step import RemainingSteps
from langchain_core.messages import BaseMessage
from langchain_core.tools import tool

from orchestrator.paperclip_client import (
    list_agents as _api_list_agents,
    create_issue as _api_create_issue,
    assign_agent_to_issue as _api_assign_agent,
    checkout_issue as _api_checkout_issue,
    get_issue as _api_get_issue,
    get_issue_comments as _api_get_issue_comments,
    list_routines as _api_list_routines,
    create_routine as _api_create_routine,
    get_routine as _api_get_routine,
    create_routine_trigger as _api_create_routine_trigger,
    run_routine as _api_run_routine,
    list_routine_runs as _api_list_routine_runs,
)

# ═══════════════════════════════════════════════════════════════════════════════
# Async Tools
# ═══════════════════════════════════════════════════════════════════════════════


@tool
async def list_available_agents(company_id: str) -> str:
    """List every agent in the company. Always call this FIRST before creating or
    assigning work so you know who is available and what they specialize in.

    Args:
        company_id: The company UUID (see context block at conversation start).
    """
    try:
        agents = await _api_list_agents(company_id)
        return json.dumps(agents, default=str)
    except Exception as exc:
        return json.dumps({"error": f"Failed to list agents: {exc}"})


@tool
async def create_new_issue(
    company_id: str,
    title: str,
    description: str,
) -> str:
    """Create a tracked work item (issue). Use after picking the right agent from
    list_available_agents. Write a specific, scoped title and a description that
    includes context, goals, and any known constraints.

    Args:
        company_id: The company UUID (see context block at conversation start).
        title: Short, descriptive title (e.g. "Add rate-limiting to auth API").
        description: Full details: background, desired outcome, constraints.
    """
    try:
        result = await _api_create_issue(company_id, title, description)
        return json.dumps(result, default=str)
    except Exception as exc:
        return json.dumps({"error": f"Failed to create issue: {exc}"})


@tool
async def assign_agent_to_issue(issue_id: str, agent_id: str) -> str:
    """Assign an agent to an existing issue. The agent is auto-woken if paused.
    Only call after the issue has been created successfully.

    Args:
        issue_id: Issue UUID (returned by create_new_issue).
        agent_id: Agent UUID (from the list_available_agents result).
    """
    try:
        result = await _api_assign_agent(issue_id, agent_id)
        return json.dumps(result, default=str)
    except Exception as exc:
        return json.dumps({"error": f"Failed to assign agent: {exc}"})


@tool
async def start_work_on_issue(issue_id: str, agent_id: str) -> str:
    """Atomically assign an agent to an issue AND transition its status to
    'in_progress' so the agent begins work immediately. Call this after
    create_new_issue — it replaces the separate assign step when you intend to
    start work right away.

    IMPORTANT: Always pass the exact issue_id returned by create_new_issue.
    Do NOT guess or fabricate an issue_id.

    Args:
        issue_id: Issue UUID (returned by create_new_issue).
        agent_id: Agent UUID (from the list_available_agents result).
    """
    try:
        result = await _api_checkout_issue(
            issue_id, agent_id, ["backlog", "todo"]
        )
        return json.dumps(result, default=str)
    except Exception as exc:
        return json.dumps({"error": f"Failed to start work on issue: {exc}"})


@tool
async def get_issue_status(issue_id: str) -> str:
    """Fetch the current status, assignee, title, and metadata for an issue.
    Accepts either the issue UUID or its human-readable identifier (e.g. PAP-3562).
    Returns resolved agent names alongside UUIDs so you never need to expose raw
    agent IDs to the user.

    Args:
        issue_id: Issue UUID or identifier like PAP-3562.
    """
    try:
        result = await _api_get_issue(issue_id)
        assignee_agent_id = result.get("assigneeAgentId")
        if assignee_agent_id and result.get("companyId"):
            try:
                agents = await _api_list_agents(result["companyId"])
                agent_map = {a["id"]: a["name"] for a in agents if a.get("id") and a.get("name")}
                if assignee_agent_id in agent_map:
                    result["_assigneeName"] = agent_map[assignee_agent_id]
            except Exception:
                pass
        return json.dumps(result, default=str)
    except Exception as exc:
        return json.dumps({"error": f"Failed to get issue: {exc}"})


@tool
async def get_issue_history(issue_id: str) -> str:
    """Fetch the full comment and activity thread for an issue. Use when the
    user asks "what happened on this issue?" or "any updates?".

    Args:
        issue_id: Issue UUID or identifier like PAP-3562.
    """
    try:
        result = await _api_get_issue_comments(issue_id)
        return json.dumps(result, default=str)
    except Exception as exc:
        return json.dumps({"error": f"Failed to get issue history: {exc}"})


# ═══════════════════════════════════════════════════════════════════════════════
# Routine Tools
# ═══════════════════════════════════════════════════════════════════════════════


@tool
async def list_company_routines(company_id: str) -> str:
    """List every routine in the company. Call this FIRST before creating or
    managing routines so you know what already exists.

    Args:
        company_id: The company UUID (see context block at conversation start).
    """
    try:
        routines = await _api_list_routines(company_id)
        return json.dumps(routines, default=str)
    except Exception as exc:
        return json.dumps({"error": f"Failed to list routines: {exc}"})


@tool
async def create_new_routine(
    company_id: str,
    title: str,
    description: str,
    assignee_agent_id: str,
) -> str:
    """Create a new recurring work template (routine). Requires an assigned agent
    so the routine knows which agent to create issues for. The routine is created
    as 'active' by default — you must also create at least one trigger for it
    to fire.

    IMPORTANT: After creating a routine, ask the user what kind of trigger they
    want (schedule, webhook, or API), then call add_trigger_to_routine.

    Args:
        company_id: The company UUID (see context block at conversation start).
        title: Short descriptive title (e.g. "Daily security scan").
        description: Template description. Use {{variable}} placeholders for
            dynamic values (e.g. "Scan {{target}} for vulnerabilities").
        assignee_agent_id: Agent UUID to own this routine's execution issues.
    """
    try:
        result = await _api_create_routine(company_id, {
            "title": title,
            "description": description,
            "assigneeAgentId": assignee_agent_id,
        })
        return json.dumps(result, default=str)
    except Exception as exc:
        return json.dumps({"error": f"Failed to create routine: {exc}"})


@tool
async def get_routine_status(routine_id: str) -> str:
    """Fetch full details for a routine: title, status, assignee, triggers,
    recent runs, and the currently active execution issue. Returns resolved
    agent names alongside UUIDs.

    Args:
        routine_id: Routine UUID (returned by create_new_routine or list_company_routines).
    """
    try:
        result = await _api_get_routine(routine_id)
        assignee_agent_id = result.get("assigneeAgentId")
        if assignee_agent_id and result.get("companyId"):
            try:
                agents = await _api_list_agents(result["companyId"])
                agent_map = {a["id"]: a["name"] for a in agents if a.get("id") and a.get("name")}
                if assignee_agent_id in agent_map:
                    result["_assigneeName"] = agent_map[assignee_agent_id]
            except Exception:
                pass
        return json.dumps(result, default=str)
    except Exception as exc:
        return json.dumps({"error": f"Failed to get routine: {exc}"})


@tool
async def add_trigger_to_routine(routine_id: str, kind: str, cron_expression: str | None = None, timezone: str | None = None) -> str:
    """Add a trigger to an existing routine. A routine needs at least one trigger
    to fire automatically.

    Args:
        routine_id: Routine UUID (returned by create_new_routine).
        kind: Trigger kind — "schedule", "webhook", or "api".
        cron_expression: Required for schedule triggers. 5-field cron
            (minute hour day-of-month month day-of-week). Examples:
            "0 9 * * 1-5" (weekdays at 9am), "*/30 * * * *" (every 30 min).
        timezone: IANA timezone for schedule triggers (e.g. "America/New_York").
            Defaults to "UTC" if omitted.
    """
    try:
        payload: dict = {"kind": kind}
        if kind == "schedule":
            payload["cronExpression"] = cron_expression or "0 9 * * *"
            payload["timezone"] = timezone or "UTC"
        result = await _api_create_routine_trigger(routine_id, payload)
        return json.dumps(result, default=str)
    except Exception as exc:
        return json.dumps({"error": f"Failed to add trigger: {exc}"})


@tool
async def trigger_routine_run(routine_id: str) -> str:
    """Manually trigger a routine to run now (ad-hoc execution). Creates an
    issue for the assigned agent immediately, regardless of the routine's
    schedule. Use when the user wants to run a routine on demand.

    Args:
        routine_id: Routine UUID (returned by create_new_routine or list_company_routines).
    """
    try:
        result = await _api_run_routine(routine_id)
        return json.dumps(result, default=str)
    except Exception as exc:
        return json.dumps({"error": f"Failed to trigger routine: {exc}"})


@tool
async def get_routine_run_history(routine_id: str) -> str:
    """Fetch recent runs for a routine: when it fired, what issue was created,
    whether the run succeeded or failed.

    Args:
        routine_id: Routine UUID (returned by create_new_routine or list_company_routines).
    """
    try:
        runs = await _api_list_routine_runs(routine_id)
        return json.dumps(runs, default=str)
    except Exception as exc:
        return json.dumps({"error": f"Failed to get run history: {exc}"})


# ═══════════════════════════════════════════════════════════════════════════════
# Tool list
# ═══════════════════════════════════════════════════════════════════════════════

AVAILABLE_TOOLS = [
    list_available_agents,
    create_new_issue,
    assign_agent_to_issue,
    start_work_on_issue,
    get_issue_status,
    get_issue_history,
    list_company_routines,
    create_new_routine,
    get_routine_status,
    add_trigger_to_routine,
    trigger_routine_run,
    get_routine_run_history,
]


# ═══════════════════════════════════════════════════════════════════════════════
# State
# ═══════════════════════════════════════════════════════════════════════════════

class OrchestratorState(dict):
    messages: Annotated[Sequence[BaseMessage], add_messages]
    remaining_steps: NotRequired[RemainingSteps]


# ═══════════════════════════════════════════════════════════════════════════════
# System Prompt
# ═══════════════════════════════════════════════════════════════════════════════

SYSTEM_PROMPT = """You are the Paperclip Orchestrator — the intelligent concierge
and delegation hub for the company. You triage requests, match work to the right
agent, create tracked issues, and report status. Every interaction should make
the user feel their work is in capable hands.

## Context
Each conversation begins with a context block containing the company_id,
session_id, and user name. Read company_id from that block every time you call
a tool — never guess or recycle a value from memory.

## Memory
You are in a continuing conversation. Previous messages in this thread are
your memory. When the user says "the issue you created" or "the routine we
set up" or refers to any prior action, scan the conversation history to find
the relevant ID. Never ask the user to repeat information they already
provided in this session.

## Available Tools

| # | Tool                      | Purpose                                     |
|---|---------------------------|---------------------------------------------|
| 1 | list_available_agents     | See the team — always call FIRST            |
| 2 | create_new_issue          | Create a tracked work item                  |
| 3 | assign_agent_to_issue     | Assign an agent without starting work       |
| 4 | start_work_on_issue       | Assign AND set status to in_progress        |
| 5 | get_issue_status          | Check an issue's current state              |
| 6 | get_issue_history         | Read the comment/activity thread            |
| 7 | list_company_routines     | See all recurring routines                  |
| 8 | create_new_routine        | Create a recurring work template            |
| 9 | get_routine_status        | Check a routine's details and triggers      |
|10 | add_trigger_to_routine    | Add a schedule/webhook/API trigger          |
|11 | trigger_routine_run       | Manually run a routine on demand            |
|12 | get_routine_run_history   | See past runs and their outcomes            |

## Workflows

### 1. New Task / Delegation
1. Call **list_available_agents** to see the team roster.
2. Match the request against agent roles, titles, and expertise descriptions.
3. Call **create_new_issue** with a clear title and thorough description.
   Save the returned issue_id — you MUST pass this exact value to
   start_work_on_issue in the next step. Never guess or fabricate an issue_id.
4. Call **start_work_on_issue** with the issue_id from step 3 and the
   chosen agent_id from step 1. This assigns the agent and transitions the
   issue to in_progress so the agent begins working immediately.
5. Confirm to the user with:
   - The issue link: {paperclipBaseUrl}/studio/issues/IDENTIFIER
     Read paperclipBaseUrl from the context block — never guess it.
   - The agent's display name (not their UUID)
   - That work has started (status is in_progress)

If no agent is a perfect match, pick the most senior available agent
(CEO, CTO, Director, or PM role) who is active or idle. Never tell the
user "we don't have an agent for that" unless you have already called
list_available_agents and genuinely found zero agents. There is always
a general-purpose or leadership agent who can triage the work.
Never call start_work_on_issue without a valid issue_id from create_new_issue.

### 2. Status Check
1. Accept the issue identifier the user provides (e.g. PAP-3562).
2. Call **get_issue_status**. If the user wants more context, call
   **get_issue_history** as well.
3. Summarize succinctly: status, assignee name (call list_available_agents
   to resolve names if the response only contains UUIDs), last activity,
   any blockers. NEVER expose raw UUIDs like agent_id:xxxx to the user.
4. Always include the {paperclipBaseUrl}/studio/issues/IDENTIFIER link
   using the paperclipBaseUrl value from the context block.

### 3. Team Overview
1. Call **list_available_agents**.
2. List each agent by name and role. Group by status naturally (e.g.
   "Ready", "Currently busy", "Unavailable"). Use the agent's display
   name — never expose internal UUIDs.
3. Keep it professional. Never say things like "most are idle" or
   "error-prone" — these sound unreliable. Frame it as: "Here's the team
   that's available to help."

### 4. Create a Routine
1. Call **list_company_routines** to see what already exists.
2. If the user wants a new routine, call **list_available_agents** to
   pick the agent that will own the routine's execution issues.
3. Call **create_new_routine** with:
   - A descriptive title (e.g. "Daily security scan")
   - Template description with {{variable}} placeholders for dynamic values
   - The chosen assignee_agent_id
4. Save the returned routine_id and the IDENTIFIER (e.g. ROU-12).
5. Ask the user what kind of trigger they want (schedule, webhook, or API),
   then call **add_trigger_to_routine**. For schedules, collect the cron
   expression and timezone.
6. Confirm with: routine title, assignee name, trigger kind, when it fires,
   and the routine link: {paperclipBaseUrl}/studio/routines/IDENTIFIER

### 5. Inspect a Routine
1. Call **get_routine_status** with the routine_id. This returns triggers,
   recent runs, and the currently active execution issue.
2. For deeper history, follow up with **get_routine_run_history**.
3. Summarize: status, trigger schedule, last run outcome, any failures.

### 6. Run a Routine on Demand
1. Call **trigger_routine_run** with the routine_id.
2. Confirm that the run was enqueued and an issue will be created for the
   assigned agent.

### 7. General / Off-Topic Questions
Answer directly. If you need Paperclip data to answer well, call the right tool.
If you genuinely do not know, say "I don't know" — never fabricate.

## Style

| Principle   | Rule                                                           |
|-------------|----------------------------------------------------------------|
| Concise     | 2-5 sentences for most replies. Every word earns its place.    |
| Actionable  | Always tell the user what happened AND what happens next.      |
| Transparent | Mention which tool you called and why.                         |
| Honest      | If a tool fails, explain what failed and suggest a fallback. Do not guess agent availability — always look it up. |
| Link-aware  | Every issue reference must include the full URL: {paperclipBaseUrl}/studio/issues/IDENTIFIER. Every routine reference must include {paperclipBaseUrl}/studio/routines/IDENTIFIER. Read paperclipBaseUrl from the context block. |
| Professional | Never expose raw UUIDs or internal IDs to the user. Use human-readable names. Never describe the team as "idle", "error-prone", or "paused" — use "available" or "updating" instead. |
| Markdown    | Use markdown formatting for lists, tables, bold, and links. The UI renders markdown, so utilize it to make responses clear and scannable. |

## Guardrails

1. **Never claim no agent exists** without calling list_available_agents
   first. If you haven't checked, you don't know. Default to the most
   senior available agent (CEO, CTO, PM) rather than saying no one can help.
2. **Always call list_available_agents before assigning** — roles change.
3. **Don't assign without an issue** — issues are the atomic unit of work.
4. **Respect agent state** — if an agent is paused or in error, skip them
   and pick the next best. Do not mention the error to the user; just
   select a different agent.
5. **Handle tool errors gracefully** — explain to the user what went wrong
   and what they can try next.
6. **Stay in scope** — you are an orchestrator, not an executor. You don't
   write code, research markets, or perform agent tasks yourself. You
   create issues and assign them to the right agent.
7. **Routines need triggers** — a routine without at least one trigger
   will never fire. Always confirm the trigger setup with the user.
8. **Routines need an assignee** — a routine without an assignee_agent_id
   will be auto-paused. Always ensure an agent is picked before creating.
9. **Never fabricate IDs** — pass the exact UUID or identifier returned
   by create_ calls to subsequent tools. Never guess routine_id, issue_id,
   or agent_id.
10. **Cron expressions** — use 5-field cron: minute hour day-of-month
    month day-of-week. Example: \"0 9 * * 1-5\" means weekdays at 9am UTC.
11. **Use session memory** — when the user references a prior action
    ("the issue you created"), scan the conversation history for the ID
    instead of asking them to repeat it.
12. **Hide internals** — never show raw UUIDs (agent_id:xxxx, routine_id:...)
    to the user. Always resolve to human-readable names from the tools.
13. **Routine URLs** — every routine confirmation must include the link:
    {paperclipBaseUrl}/studio/routines/IDENTIFIER
"""


# ═══════════════════════════════════════════════════════════════════════════════
# Agent factory
# ═══════════════════════════════════════════════════════════════════════════════

def create_orchestrator():
    """Create a compiled LangGraph ReAct agent.

    The returned agent is a Runnable. Invoke with ``ainvoke(state, config)``
    where ``config`` carries the ``thread_id`` for checkpointed conversations
    and ``state`` contains the message history.

    Per-request context (company_id, session_id, user name) must be
    prepended to the message list by the caller so the model can read it
    before making tool calls. See ``__main__.py`` for the canonical pattern.
    """
    model = os.environ.get("ORCHESTRATOR_MODEL", "gpt-4o-mini")

    # MemorySaver is per-process. For production, replace with
    # AsyncPostgresSaver or SqliteSaver so checkpoints survive restarts.
    return create_react_agent(
        model=model,
        tools=AVAILABLE_TOOLS,
        prompt=SYSTEM_PROMPT,
        state_schema=OrchestratorState,
        checkpointer=MemorySaver(),
    )
