---
name: google-workspace-mcp
description: >
  Use Google Workspace through already-configured MCP tools (Gmail, Calendar,
  Drive). Do not use Paperclip connector APIs or third-party gateway endpoints.
---

# Google Workspace MCP

Use this skill whenever a task requires Gmail, Google Calendar, or Google Drive actions.

## Rules

1. Use only the Google Workspace MCP toolset already available to the runtime.
2. Do not call Paperclip connector endpoints for normal work.
3. Do not use Maton or any external Gmail gateway URLs.
4. Assume OAuth tokens are already configured unless a tool returns an auth error.

## Tool Selection

Pick tools from the connected MCP namespace that match Google Workspace capabilities:

- Gmail: read/search/send/reply/draft
- Calendar: list events/create events/update events
- Drive: list/search/read metadata

If multiple similar tools exist, prefer the one that is:

1. Explicitly scoped to Google Workspace
2. Read-only for discovery steps
3. Narrowest in permissions and output

## Execution Pattern

1. Verify access with one low-risk read call (for example: list recent mail, list upcoming events, or list drive files).
2. Perform the user request with minimal calls.
3. Return a concise action summary and outcome.

## Error Handling

If a call fails:

1. Capture the exact tool name and error text.
2. If auth-related, report: "Google Workspace MCP authentication failed for `<tool>`."
3. Do not invent fallback APIs. Ask for MCP auth refresh only when the tool indicates auth/permission failure.

