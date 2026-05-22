"""
SessionContextManager — reads/writes SessionContext via chat_sessions.metadata.

Handles the sliding 10-message window, delegation tracking, and cursor management.
"""

import uuid
from datetime import datetime, timezone
from typing import Any

from orchestrator.paperclip_client import get_session_context, update_session_context


class SessionContext:
    """In-memory representation of session context."""

    def __init__(self, data: dict | None = None):
        self.session_id: str = ""
        self.company_id: str = ""
        self.user_id: str = ""
        self.issue_ids: list[str] = []
        self.focused_issue_id: str | None = None
        self.delegations: list[dict] = []
        self.last_handoff_markdown: str | None = None
        self.last_handoff_at: str | None = None
        self.message_cursor: str | None = None

        if data:
            self._load(data)

    def _load(self, data: dict):
        self.session_id = data.get("sessionId", "")
        self.company_id = data.get("companyId", "")
        self.user_id = data.get("userId", "")
        self.issue_ids = data.get("issueIds", [])
        self.focused_issue_id = data.get("focusedIssueId")
        self.delegations = data.get("delegations", [])
        self.last_handoff_markdown = data.get("lastHandoffMarkdown")
        self.last_handoff_at = data.get("lastHandoffAt")
        self.message_cursor = data.get("messageCursor")

    def to_dict(self) -> dict:
        return {
            "sessionId": self.session_id,
            "companyId": self.company_id,
            "userId": self.user_id,
            "issueIds": self.issue_ids,
            "focusedIssueId": self.focused_issue_id,
            "delegations": self.delegations,
            "lastHandoffMarkdown": self.last_handoff_markdown,
            "lastHandoffAt": self.last_handoff_at,
            "messageCursor": self.message_cursor,
        }


class SessionContextManager:
    """Manages loading, saving, and updating SessionContext."""

    async def load(self, session_id: str) -> SessionContext:
        """Load SessionContext from chat_sessions.metadata."""
        raw = await get_session_context(session_id)
        return SessionContext(raw)

    async def save(self, session_id: str, ctx: SessionContext) -> None:
        """Save SessionContext to chat_sessions.metadata (full overwrite)."""
        await update_session_context(session_id, ctx.to_dict())

    async def add_delegation(
        self,
        session_id: str,
        agent_id: str,
        agent_name: str,
        issue_id: str | None,
    ) -> dict:
        """Add a new delegation record and return it."""
        ctx = await self.load(session_id)
        delegation = {
            "delegationId": str(uuid.uuid4()),
            "agentId": agent_id,
            "agentName": agent_name,
            "issueId": issue_id,
            "status": "pending",
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "completedAt": None,
            "summary": None,
        }
        ctx.delegations.append(delegation)
        await self.save(session_id, ctx)
        return delegation

    async def update_delegation_status(
        self,
        session_id: str,
        delegation_id: str,
        status: str,
        summary: str | None = None,
    ) -> None:
        """Update the status of an existing delegation."""
        ctx = await self.load(session_id)
        for d in ctx.delegations:
            if d.get("delegationId") == delegation_id:
                d["status"] = status
                d["completedAt"] = datetime.now(timezone.utc).isoformat()
                if summary is not None:
                    d["summary"] = summary
                break
        await self.save(session_id, ctx)

    async def get_recent_messages(self, session_id: str, limit: int = 10) -> list[dict]:
        """
        Fetch recent messages for the session from the Paperclip API.
        Returns messages in {role, content} format suitable for LLM prompts.
        """
        from orchestrator.paperclip_client import (
            PAPERCLIP_API_BASE,
            _client,
        )

        try:
            async with _client() as client:
                resp = await client.get(
                    f"{PAPERCLIP_API_BASE}/chat/sessions/{session_id}/messages?limit={limit}"
                )
                if resp.status_code == 404:
                    return []
                resp.raise_for_status()
                data = resp.json()
                messages = data.get("messages", data) if isinstance(data, dict) else data
                # Normalize to {role, content}
                normalized = []
                for msg in messages:
                    role = "assistant" if msg.get("isBot") or msg.get("role") == "assistant" else "user"
                    content = msg.get("content", msg.get("text", ""))
                    normalized.append({"role": role, "content": content})
                return normalized
        except Exception:
            # Fallback: return empty list if API is unavailable
            return []

    async def advance_cursor(self, session_id: str, cursor: str) -> None:
        """Advance the message cursor to the given message ID or timestamp."""
        ctx = await self.load(session_id)
        ctx.message_cursor = cursor
        await self.save(session_id, ctx)
