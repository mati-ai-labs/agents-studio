"""
FastAPI app exposing the LangGraph orchestrator.

Uses LangGraph's create_react_agent — the LLM IS the agent.
We provide tools + a role system prompt. The agent decides autonomously.

Per-request context (company_id, session_id, user) is injected into the
message list so the model can read it before making tool calls.

Run:
  cd server/src/orchestrator && pip install langchain-openai langgraph
  OPENAI_API_KEY=xxx ORCHESTRATOR_MODEL=gpt-4o-mini python -m orchestrator.__main__
  uvicorn orchestrator.__main__:app --host 0.0.0.0 --port 3101
"""

import os
import json
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from orchestrator.graph import create_orchestrator

PAPERCLIP_BASE_URL = os.environ.get("PAPERCLIP_BASE_URL", "http://127.0.0.1:3100")


# ── Pydantic models ──────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    session_id: str
    company_id: str
    user_id: str
    message: str


# ── Helpers ──────────────────────────────────────────────────────────────────

def _build_context_block(req: ChatRequest) -> str:
    """Build a context block the model reads for company_id / session scoping."""
    return (
        f"[Context block — read before acting]\n"
        f"company_id: {req.company_id}\n"
        f"session_id:  {req.session_id}\n"
        f"user:        {req.user_id}\n"
        f"paperclipBaseUrl: {PAPERCLIP_BASE_URL}\n"
        f"[End context block]"
    )


def _build_messages(req: ChatRequest) -> list[dict]:
    """Build the message list for ainvoke with context prepended."""
    context_block = _build_context_block(req)
    return [
        {"role": "user", "content": context_block},
        {"role": "user", "content": req.message},
    ]


# ── Lifespan / agent init ────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.agent = create_orchestrator()
    yield


app = FastAPI(title="Paperclip Orchestrator", lifespan=lifespan)


# ── Health ───────────────────────────────────────────────────────────────────

@app.get("/orchestrator/health")
async def health() -> dict:
    return {"status": "ok", "service": "orchestrator"}


# ── Non-streaming chat ───────────────────────────────────────────────────────

@app.post("/orchestrator/chat")
async def chat(req: ChatRequest) -> dict:
    agent = app.state.agent

    config = {"configurable": {"thread_id": req.session_id}}

    state = {"messages": _build_messages(req)}

    try:
        result = await agent.ainvoke(state, config)
        messages = result.get("messages", [])
        final = next(
            (
                m.content
                for m in reversed(messages)
                if hasattr(m, "content") and m.content
            ),
            "No response generated.",
        )
        return {"response": final}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ── SSE streaming ────────────────────────────────────────────────────────────

@app.post("/orchestrator/chat/stream")
async def chat_stream(req: ChatRequest) -> StreamingResponse:
    """
    Stream the response as Server-Sent Events.

    ReAct agent doesn't support per-token streaming out of the box, so we
    invoke normally and yield the full response as a single SSE message event,
    matching the format the existing CEO chat consumer expects.
    """
    agent = app.state.agent
    config = {"configurable": {"thread_id": req.session_id}}

    state = {"messages": _build_messages(req)}

    async def event_generator():
        try:
            result = await agent.ainvoke(state, config)
            messages = result.get("messages", [])
            final = next(
                (
                    m.content
                    for m in reversed(messages)
                    if hasattr(m, "content") and m.content
                ),
                "No response generated.",
            )
            yield f"event: message\ndata: {json.dumps({'content': final})}\n\n"
            yield "event: done\ndata: {}\n\n"
        except Exception as exc:
            yield f"event: error\ndata: {json.dumps({'error': str(exc)})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── Entrypoint ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("ORCHESTRATOR_PORT", "3101"))
    uvicorn.run(app, host="0.0.0.0", port=port)
