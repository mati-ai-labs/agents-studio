---
name: market-research-agent
description: >
  Perform autonomous B2B market research: discover companies, qualify leads,
  generate outreach drafts, and monitor market signals. Use when the board or CEO
  asks for market research, competitive intelligence, lead discovery, or
  strategic market analysis. Not for product development tasks, coding, or
  general Q&A.
---

# Market Research Agent Skill

Given a research mission, this skill discovers real companies, scores them against
an ICP, surfaces decision-maker leads, generates outreach drafts, and
auto-schedules follow-up research. Runs entirely via web search and LLM reasoning
with no external agent server needed.

---

## Trigger

Use when you see messages like:
- "research companies in [segment]"
- "find me Series A SaaS companies actively hiring"
- "who is our ideal customer profile in fintech"
- "competitor analysis for [market]"
- "lead generation for [use case]"
- Any task involving market intelligence, company discovery, or outreach targeting

---

## Inputs

### Required
- `mission` — the research goal in plain language
  e.g. "Find Series A SaaS companies in fintech that raised in 2025 and are actively hiring sales teams"

### Optional
- `companyDNA` — context about your own company
  ```json
  {
    "name": "Our Company",
    "targetVerticals": ["fintech", "b2b saas"],
    "idealCustomerProfile": "...",
    "painPoints": ["manual lead gen"],
    "competitors": ["competitor-a"]
  }
  ```
- `icpRules` — filter rules for qualifying companies
  ```json
  [
    { "text": "funded Series A 2024-2025", "label": "Funding" },
    { "text": "50-500 employees", "label": "Size" },
    { "text": "hiring head of sales", "label": "Intent Signal" }
  ]
  ```
- `uploadedDocs` — reference documents (if provided in task context)

---

## Workflow

### Step 1 — Web Evidence Collection

Build 6 targeted search queries based on the mission:

1. Funding rounds for the target segment (current year)
2. Companies that raised Seed/Series A/Series B
3. Product launches in the target space
4. Hiring signals (head of sales, growth, operations roles)
5. Customer case studies or pain point articles
6. Competitor alternatives or market comparisons

Use the `web_search` tool. Run all 6 queries in parallel with `Promise.all`.
Each query should return 4 results. Collect up to 18 deduplicated results total.

Env vars that control this (fallback defaults):
- `RESEARCH_SEARCH_QUERY_COUNT` = 6
- `RESEARCH_SEARCH_RESULTS_PER_QUERY` = 4
- `RESEARCH_WEB_EVIDENCE_MAX` = 18

### Step 2 — Deduplicate Evidence

Deduplicate by URL or by title+snippet fingerprint. Keep only the first
occurrence of each unique evidence item. Cap at 18 total.

Discard evidence that has no URL, no title, and no snippet — these cannot be cited.

### Step 3 — ICP Filtering

Score each discovered company against the ICP rules:
- Funding stage match
- Company size match
- Hiring / intent signal match
- Vertical/segment fit
- Any custom rules from `icpRules`

Assign a confidence score 0–100. Flag companies with confidence < 75 as
`needsHumanJudgment: true` — these need manual review before outreach.

### Step 4 — Structured Output

Return three artifacts:

#### Opportunities
```json
[{
  "id": "opp-{timestamp}-{index}",
  "company": "Acme Corp",
  "industry": "Fintech",
  "confidence": 85,
  "icpMatch": 82,
  "signals": ["raised Series A 2024", "hired VP Sales Q1 2025"],
  "employees": 150,
  "tam": "$500M",
  "stage": "Series A",
  "sourceUrl": "https://example.com/article",
  "evidence": "Full snippet or reasoning",
  "needsHumanJudgment": false,
  "status": "pending"
}]
```

#### Leads
```json
[{
  "id": "lead-{timestamp}-{index}",
  "name": "Jane Smith",
  "title": "VP of Sales",
  "company": "Acme Corp",
  "confidence": 78,
  "lastActivity": "Newly researched",
  "rationale": "Found via LinkedIn + funding announcement",
  "sourceUrl": "https://linkedin.com/in/jane"
}]
```

#### Drafts
```json
[{
  "id": "draft-{timestamp}-{index}",
  "content": "Hi Jane, I noticed Acme just raised Series A and is building out their sales team. We help companies like yours...",
  "rationale": "Personalized based on funding news + VP Sales title",
  "leadId": "lead-{id}",
  "status": "draft"
}]
```

### Step 5 — Auto-Scheduling

After every research run, create 2 recurring follow-up schedules using
`POST /api/companies/{companyId}/routines`:

1. **Daily signal scan** — `0 9 * * 1-5` (weekday 9am)
   - Task: scan for new funding, hiring, and product signals matching the mission
   - Purpose: keep the pipeline fresh without manual prompting

2. **Weekly synthesis** — `0 10 * * 1` (Monday 10am)
   - Task: summarize the week's market changes, rank top opportunities, update ICP assumptions
   - Purpose: turn raw signals into strategic recommendations

Only create these if they don't already exist (check with `GET /api/companies/{companyId}/routines` first, dedupe by name or dedupeKey).

If cron scheduling via API is not available, write the schedules to memory so a
human can configure them manually.

### Step 6 — Write to Drive (Best Effort)

If Google Drive credentials are available, write results to Drive:
- Folder: `Agent Studio Research` (create if missing)
- File: `YYYY-MM-DD-market-research.md`
- Format: Markdown with task, job name, and full research output

Failures here are non-fatal — continue the flow even if Drive write fails.

---

## Quality Rules

1. **No invented companies** — only return companies where you found a real name,
   real URL, and real evidence. If search returns insufficient data, return empty
   lists rather than hallucinate.
2. **Human judgment threshold** — confidence < 75 → `needsHumanJudgment: true`
3. **Deduplicate aggressively** — same URL = one entry only
4. **Filter generic terms** — discard results where the "company" name is just
   "b2b saas", "startup", "market research", "lead generation", etc.
5. **Evidence over assumption** — every opportunity needs at least one
   sourceUrl, evidence snippet, or signal to be included

---

## Tools

- `web_search` — use this for all evidence collection
- `GET /api/companies/{companyId}/routines` — check existing schedules
- `POST /api/companies/{companyId}/routines` — create recurring research schedules
- Google Drive API (if available) — write research files

---

## Output Format

When done, respond with a clean summary:

**Opportunities found:** N (list top 3 with company + confidence)
**Leads identified:** N (list top 3 with name + title + company)
**Drafts generated:** N (show preview of first draft)
**Scheduled:** Daily scan at 9am weekdays, Weekly synthesis Monday 10am

Followed by the full structured JSON for each artifact type.

---

## What to Delegate vs. Do Yourself

- Web search + evidence collection → do yourself (fast, parallel)
- Company scoring + ICP analysis → do yourself (LLM reasoning)
- Outreach draft writing → do yourself (generate 1-3 drafts)
- Schedule creation → do yourself (API call or memory note)
- Strategic interpretation + recommendation → do yourself (your judgment is the value)

Do NOT try to hand off web research to another agent — you have the tools.