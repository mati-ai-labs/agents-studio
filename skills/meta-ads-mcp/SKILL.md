---
name: meta-ads-mcp
description: >
  Manage Meta (Facebook) Ads campaigns, analytics, audiences, and creatives
  through the Meta Ads MCP server. Token is auto-fetched from Paperclip's
  connector credentials API by a wrapper script on every MCP server start.
compatibility: >
  Claude Code running on agentstudio EC2. meta-ads-mcp npm package + wrapper
  script must be installed. Meta Ads connector must be configured in Paperclip
  for the tenant.
---

# Meta Ads MCP

Use this skill whenever a task requires reading or managing Meta (Facebook) Ads
campaigns, ad sets, ads, analytics, audiences, or creatives.

## How It Works

The MCP server is started by Claude Code via a wrapper script
(`/data/meta-ads-mcp-wrapper.sh`). On every MCP server start, the wrapper:
1. Calls `https://agentstudio.matilabs.com/api/agents/$PAPERCLIP_AGENT_ID/connector-credentials/meta_ads`
2. Extracts the tenant's Meta access token from the response
3. Launches `meta-ads-mcp` with `META_ACCESS_TOKEN` set to the fetched token

**No manual token setup needed.** If the token is expired, Paperclip's heartbeat
auto-refreshes it. If the connector isn't configured, the MCP server fails to
start with a clear error message.

## Prerequisites

The assistant must verify these are in place before starting work:

- `meta-ads-mcp` npm package installed globally
- `/data/meta-ads-mcp-wrapper.sh` wrapper script exists and is executable
- `.claude.json` has `meta-ads` in `mcpServers` pointing at the wrapper
- Meta Ads connector configured in Paperclip for the tenant (Board → Connectors)

---

## Step 1 — Verify MCP Server is Running (Always Do First)

Before running any ad operation, verify the MCP server started successfully by
making one low-risk read call:

```
List my available Meta ad accounts
What ad accounts do I have access to?
Show me all ad accounts for this business
```

If the MCP server failed to start, you'll see an error. Common causes:

| Error | Fix |
|-------|-----|
| "Failed to fetch Meta Ads token" | Connect Meta Ads in Board → Connectors |
| "No credentials stored" | Tenant hasn't completed OAuth; direct them to Board → Connectors |
| "PAPERCLIP_AGENT_ID must be set" | Paperclip runtime env missing; check heartbeat config |
| Tool not found (`mcp__meta-ads__*` unavailable) | MCP server didn't start; check Claude Code logs |

---

## Step 2 — Use MCP Tools

All Meta Ads operations go through the `mcp__meta-ads__*` tool namespace. The
server provides 40+ tools covering:

### Campaign Management
```
List campaigns:     mcp__meta-ads__list_campaigns
Create campaign:    mcp__meta-ads__create_campaign
Update campaign:    mcp__meta-ads__update_campaign (pause, resume, delete, budget changes)
Create ad sets:     mcp__meta-ads__create_ad_set
Create individual ads: mcp__meta-ads__create_ad
```

### Analytics & Reporting
```
Campaign insights:     mcp__meta-ads__get_campaign_insights
Daily performance:      mcp__meta-ads__get_daily_performance
Multi-campaign compare: mcp__meta-ads__compare_campaigns
```

### Audience Management
```
Custom audiences:       mcp__meta-ads__create_custom_audience
Lookalike audiences:    mcp__meta-ads__create_lookalike_audience
Audience size estimate: mcp__meta-ads__estimate_audience_size
Audience health:        mcp__meta-ads__get_audience_health
```

### Creative Management
```
Ad creatives:     mcp__meta-ads__create_ad_creative
Ad previews:      mcp__meta-ads__get_ad_preview
A/B testing:      mcp__meta-ads__create_ab_test
```

### MCP Resources
```
Campaign overview:      meta://campaigns/{account_id}
Performance dashboard:  meta://insights/account/{account_id}
Audience insights:      meta://audiences/{account_id}
Audience health report: meta://audience-health/{account_id}
```

---

## Usage Examples

### Campaign Operations
```
Create a new traffic campaign named "Summer Sale" with $50 daily budget
Pause all campaigns with CPC above $2.00
List all active campaigns and their current spend
```

### Analytics & Reporting
```
Compare the performance of my top 3 campaigns over the last 30 days
Show me daily performance trends for campaign <id> over the last 14 days
What's the overall ROAS for account <id> this month?
```

### Audience
```
Create a lookalike audience based on my best customers targeting US users
Show me the health status of all my custom audiences
Estimate the audience size for females aged 25-45 interested in fitness
```

### Creatives
```
Create an ad creative with title "Flash Sale" and preview it for mobile feed
Set up an A/B test with two headlines for campaign <id>
```

---

## Rules

1. **Read before write** — always do one read call (e.g., list ad accounts) to
   verify access before mutating anything.
2. **MCP tools only** — do not call Facebook Graph API directly. Route everything
   through `mcp__meta-ads__*` tools.
3. **Rate limits** — the MCP server auto-handles Meta API rate limits
   (development tier: 60/5min, standard tier: 9000/5min). If you hit a rate
   limit error, wait 60 seconds and retry.
4. **Multi-account** — if the response includes multiple ad accounts, ask the
   user which account to target. Default to the first active account for
   convenience.
5. **Never log tokens** — the wrapper handles tokens internally. Don't echo or
   export `META_ACCESS_TOKEN`.

## Error Recovery

If MCP tools return auth/connection errors mid-session:

1. The token may have expired (60-day long-lived tokens). Report to the user:
   "Meta Ads token appears expired. The Paperclip heartbeat will refresh it on
   the next agent run, or re-authorize in Board → Connectors."
2. If it's a transient network error, retry once after 10 seconds.
3. If the MCP server is completely unavailable, Claude Code may need to restart
   the session to trigger a fresh MCP server launch with a new token fetch.
