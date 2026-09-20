---
name: vector-memory
description: >
  PostgreSQL-backed vector memory with semantic search. Store, retrieve,
  and search memories using OpenAI embeddings for semantic similarity.
  All entries are scoped by user_id. In Paperclip, user_id MUST always be
  the current Paperclip company ID so company memories remain isolated.
---

# Vector Memory Skill

Persistent memory backed by PostgreSQL with pgvector. Uses OpenAI text-embedding-3-small
(1536 dimensions) for semantic search. In Paperclip, every entry is scoped by the
current company ID passed as user_id.

## Tools

- memory_remember(user_id, category, key, value) — Store/update a memory
- memory_recall(user_id, category, key) — Read a specific memory
- memory_list(user_id, category?) — List all memories for a user
- memory_forget(user_id, category, key) — Delete a memory
- memory_search(user_id, query, top_k?) — Semantic search using OpenAI embeddings
- memory_record_event(user_id, kind, body) — Record a journal event

## Usage

### Mandatory Paperclip scope

When running inside Paperclip, `user_id` MUST be the current Paperclip
`company_id` UUID.

- Read the company ID from the task, runtime context, agent context, or Paperclip API.
- Pass that exact company ID as `user_id` to every vector-memory tool call.
- Never use an email address, agent ID, agent name, issue ID, run ID, or a generic value such as `default`.
- Never reuse a company ID from another task or company.
- If the company ID is unavailable or ambiguous, do not call a memory tool. Resolve the company context first.

Example company ID: `3f83238b-de99-4408-93ee-3d8fab56b4af`

To store a memory:
  memory_remember(user_id="3f83238b-de99-4408-93ee-3d8fab56b4af", category="products", key="primary-offering", value="The company offers...")

To recall a specific memory:
  memory_recall(user_id="3f83238b-de99-4408-93ee-3d8fab56b4af", category="products", key="primary-offering")

To search semantically (uses OpenAI embeddings, not just keywords):
  memory_search(user_id="3f83238b-de99-4408-93ee-3d8fab56b4af", query="What products does this company offer?", top_k=3)

To list all memories for a company:
  memory_list(user_id="3f83238b-de99-4408-93ee-3d8fab56b4af", category="products")

To record a journal event:
  memory_record_event(user_id="3f83238b-de99-4408-93ee-3d8fab56b4af", kind="market_signal", body={"signal": "Demand increased", "source": "..."})

## MCP Server

The vector-memory MCP server runs on the Agents Studio EC2.
It connects to PostgreSQL with pgvector extension at port 54329.

## Important

- `user_id` is REQUIRED on every call and MUST equal the current Paperclip company ID
- There is no implicit current-company or current-user context in the MCP server
- Using the wrong ID can write to or query the wrong memory namespace
- Cross-company isolation depends on consistently passing the correct company ID in `user_id`
- Cross-user isolation is enforced at the database level via WHERE clauses
- category can be any string; use lowercase with underscores
- journal entries via memory_record_event are stored in category="__journal__"
- Vector dimension: 1536 (OpenAI text-embedding-3-small)
