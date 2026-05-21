---
name: minimax-web-search
description: >
  Use MiniMax MCP web search for fast, source-backed, time-sensitive research.
  Trigger this when tasks require current external facts, news checks, vendor
  comparisons, or citation-ready summaries grounded in fresh web results.
---

# MiniMax Web Search Skill

Use this skill when you need reliable, current information from the public web.

## When to use

- The task depends on "latest", "today", "recent", or changing facts.
- You must produce source-backed summaries with links.
- You need quick competitive scans, pricing checks, policy checks, or release checks.

## Preconditions

- The `MiniMax` MCP server is available in the current agent environment.
- The server exposes the `web_search` tool.

If the MCP server is unavailable, explicitly state the blocker and continue with the best available fallback.

## Workflow

1. Clarify the target outcome before searching.
- Identify what must be answered exactly.
- Capture any constraints (region, date range, source quality requirements).

2. Query in focused passes.
- Start broad to map the landscape.
- Follow with narrow queries for verification and edge cases.
- Prefer primary sources (official docs, first-party announcements, regulators, original publishers).

3. Validate and triangulate.
- Confirm important claims across at least two independent sources when possible.
- Record publish/update dates for time-sensitive claims.
- Flag uncertainty instead of guessing.

4. Produce a decision-ready output.
- Lead with direct answer(s).
- Add bullet-point evidence with source links.
- Separate confirmed facts from inferred conclusions.

## Output quality bar

- No unsourced factual claims.
- No stale "latest" statements without date context.
- Include concrete links for key claims.
- Keep recommendations scoped to the user's actual decision.
