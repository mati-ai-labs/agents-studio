"""
Paperclip API client — internal HTTP calls to the existing Paperclip server.

All endpoints are existing routes in server/src/routes/*.ts.
Paperclip runs alongside this Python service on the same host (localhost:3100).
"""

import os
import httpx
from typing import Any

PAPERCLIP_API_BASE = os.environ.get("PAPERCLIP_API_BASE", "http://127.0.0.1:3100/api")
ORCHESTRATOR_API_KEY = os.environ.get("ORCHESTRATOR_API_KEY", "")


def _client() -> httpx.AsyncClient:
    headers = {}
    if ORCHESTRATOR_API_KEY:
        headers["Authorization"] = f"Bearer {ORCHESTRATOR_API_KEY}"
    return httpx.AsyncClient(timeout=30.0, headers=headers)


async def list_agents(company_id: str) -> list[dict]:
    """GET /api/companies/:companyId/agents"""
    async with _client() as client:
        resp = await client.get(f"{PAPERCLIP_API_BASE}/companies/{company_id}/agents")
        resp.raise_for_status()
        return resp.json()


async def create_issue(company_id: str, title: str, description: str) -> dict:
    """POST /api/companies/:companyId/issues"""
    async with _client() as client:
        resp = await client.post(
            f"{PAPERCLIP_API_BASE}/companies/{company_id}/issues",
            json={"title": title, "description": description},
        )
        resp.raise_for_status()
        return resp.json()


async def assign_agent_to_issue(issue_id: str, agent_id: str) -> dict:
    """PATCH /api/issues/:id with {assigneeAgentId: agent_id}"""
    async with _client() as client:
        resp = await client.patch(
            f"{PAPERCLIP_API_BASE}/issues/{issue_id}",
            json={"assigneeAgentId": agent_id},
        )
        resp.raise_for_status()
        return resp.json()


async def checkout_issue(issue_id: str, agent_id: str, expected_statuses: list[str]) -> dict:
    """POST /api/issues/:id/checkout — atomically assign agent and set status to in_progress"""
    async with _client() as client:
        resp = await client.post(
            f"{PAPERCLIP_API_BASE}/issues/{issue_id}/checkout",
            json={"agentId": agent_id, "expectedStatuses": expected_statuses},
        )
        resp.raise_for_status()
        return resp.json()


async def get_issue(issue_id: str) -> dict:
    """GET /api/issues/:id"""
    async with _client() as client:
        resp = await client.get(f"{PAPERCLIP_API_BASE}/issues/{issue_id}")
        resp.raise_for_status()
        return resp.json()


async def get_issue_comments(issue_id: str) -> list[dict]:
    """GET /api/issues/:id/comments"""
    async with _client() as client:
        resp = await client.get(f"{PAPERCLIP_API_BASE}/issues/{issue_id}/comments")
        resp.raise_for_status()
        return resp.json()


async def get_company(company_id: str) -> dict:
    """GET /api/companies/:companyId"""
    async with _client() as client:
        resp = await client.get(f"{PAPERCLIP_API_BASE}/companies/{company_id}")
        resp.raise_for_status()
        return resp.json()



async def list_routines(company_id: str, project_id: str | None = None) -> list[dict]:
    """GET /api/companies/:companyId/routines"""
    async with _client() as client:
        params = {}
        if project_id:
            params["projectId"] = project_id
        resp = await client.get(
            f"{PAPERCLIP_API_BASE}/companies/{company_id}/routines",
            params=params,
        )
        resp.raise_for_status()
        return resp.json()


async def create_routine(company_id: str, data: dict) -> dict:
    """POST /api/companies/:companyId/routines"""
    async with _client() as client:
        resp = await client.post(
            f"{PAPERCLIP_API_BASE}/companies/{company_id}/routines",
            json=data,
        )
        resp.raise_for_status()
        return resp.json()


async def get_routine(routine_id: str) -> dict:
    """GET /api/routines/:id"""
    async with _client() as client:
        resp = await client.get(f"{PAPERCLIP_API_BASE}/routines/{routine_id}")
        resp.raise_for_status()
        return resp.json()


async def create_routine_trigger(routine_id: str, data: dict) -> dict:
    """POST /api/routines/:id/triggers"""
    async with _client() as client:
        resp = await client.post(
            f"{PAPERCLIP_API_BASE}/routines/{routine_id}/triggers",
            json=data,
        )
        resp.raise_for_status()
        return resp.json()


async def run_routine(routine_id: str, data: dict | None = None) -> dict:
    """POST /api/routines/:id/run"""
    async with _client() as client:
        resp = await client.post(
            f"{PAPERCLIP_API_BASE}/routines/{routine_id}/run",
            json=data or {},
        )
        resp.raise_for_status()
        return resp.json()


async def list_routine_runs(routine_id: str, limit: int = 50) -> list[dict]:
    """GET /api/routines/:id/runs"""
    async with _client() as client:
        resp = await client.get(
            f"{PAPERCLIP_API_BASE}/routines/{routine_id}/runs",
            params={"limit": limit},
        )
        resp.raise_for_status()
        return resp.json()


async def get_session_context(session_id: str) -> dict:
    """GET /api/chat/sessions/:id/context"""
    async with _client() as client:
        resp = await client.get(f"{PAPERCLIP_API_BASE}/chat/sessions/{session_id}/context")
        resp.raise_for_status()
        return resp.json()


async def update_session_context(session_id: str, context: dict) -> dict:
    """PATCH /api/chat/sessions/:id/context (partial merge)"""
    async with _client() as client:
        resp = await client.patch(
            f"{PAPERCLIP_API_BASE}/chat/sessions/{session_id}/context",
            json=context,
        )
        resp.raise_for_status()
        return resp.json()
