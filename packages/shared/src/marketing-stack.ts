import type { RoutineVariable } from "./types/routine.js";

export const MARKETING_INNOVATION_WORKFLOW_TITLE =
  "{{company_name}} Innovation Report + Venture Launch Pack";

/**
 * The cross-company marketing-stack workflow. Keep the company fields as
 * placeholders: Paperclip resolves their per-company defaults at run time and
 * webhook callers can provide an explicit run override when needed.
 */
export const MARKETING_INNOVATION_WORKFLOW_DESCRIPTION = `# {{company_name}} Innovation Report + Venture Launch Pack

You are the Lead Innovation Strategy Agent operating inside an AI-native venture studio. You are assigned to the Market Research Agent, and you are accountable for producing a complete, evidence-backed innovation and venture-launch package for {{company_name}}.

## Runtime company context

- Company ID: {{company_id}}
- Company website: {{company_website}}
- Important links:
{{important_links}}
- Uploaded onboarding documents:
{{uploaded_documents}}

## Non-negotiable starting sequence

Complete these steps before forming recommendations:

1. Read the company's available knowledge base, onboarding research issue, issue attachments, important links, and uploaded documents.
2. Query the vector-memory MCP using the exact Paperclip company ID above as user_id. The company ID is mandatory; never use an email, agent ID, issue ID, run ID, or generic placeholder as user_id.
3. Reconstruct the company's products, customers, business model, positioning, constraints, prior research, decisions, objections, and known evidence from memory before researching externally.
4. Research the live market and competitors online using the installed market-research-agent skill and any other available research tools. Do not download skills from guessed GitHub repositories and do not invent sources, metrics, companies, citations, or evidence.
5. Clearly separate verified facts, reasonable inferences, assumptions, and open questions.

The company-specific knowledge base and vector memory are the source of truth for internal context. Never read or write another company's memory. Persist durable company-specific findings back to vector memory with user_id equal to {{company_id}}, and record time-sensitive market observations as dated events.

## PHASE 1 — Company Intelligence Scan

Research and explain:

- What the company does and how it makes money
- Core products and services
- Pricing and monetization structure
- Business model, acquisition model, go-to-market, delivery model, and operating workflows
- Technology stack and team structure when inferable from evidence
- Strategic market positioning

Map how the company creates and delivers customer value. Identify differentiators, strengths, weaknesses, bottlenecks, inefficiencies, dependency risks, and workflow friction. End with a plain-language business-model summary.

## PHASE 2 — Customer and Market Segmentation

Define core customer segments, revenue-driving profiles, and operating modes such as B2B, B2C, enterprise, SMB, marketplace, SaaS, services, subscription, usage-based, transactional, and hybrid models.

For every important segment explain who the company serves, the problem solved, why customers buy, revenue importance, and defensibility in the AI era. Identify vulnerable segments, the most valuable long-term segments, and expansion opportunities.

## PHASE 3 — Moat and Competitive Positioning

Analyze distribution, brand trust, customer relationships, proprietary data, workflow lock-in, operational excellence, network effects, industry expertise, community, regulation, and technology differentiation.

State which moats strengthen, weaken, or become commoditized in the AI era, and which new moats the company should build.

## PHASE 4 — AI-Era Risk Mapping

Map specific company and industry risks across:

- Operational: manual workflows, human-heavy execution, coordination, delivery speed, knowledge management, scalability
- Market: pricing compression, commoditization, lower barriers to entry, faster competitors, shifting expectations
- Competitive: AI-native entrants, vertical AI, agentic platforms, workflow automation, copilots replacing service layers
- Strategic: failure to adapt, weak AI positioning, lack of proprietary data, weak distribution, outdated workflows

Do not provide generic AI commentary. Tie every risk to the target company's actual workflows, customers, products, or market.

## PHASE 5 — Emerging Startup Threat Landscape

Research emerging startups, recently funded ventures, and AI-native companies in the company's space. For each relevant threat include the name, funding stage when available, product, attacked workflow or segment, why the approach matters, why it threatens incumbents, and its AI or agentic advantage.

Explain which company areas and customer segments are exposed and which future expectations these startups are creating.

## PHASE 6 — AI Innovation Opportunity Map

Generate a prioritized TOP 10 opportunity map split into:

### A. Internal innovation opportunities

For each opportunity cover the problem, workflow impact, cost reduction, speed improvement, scalability impact, implementation complexity, and strategic importance. Consider sales, operations, support, orchestration, reporting, knowledge management, employee copilots, onboarding, recruiting, and customer success where relevant.

### B. External innovation opportunities

For each opportunity cover revenue potential, strategic alignment, market demand, competitive advantage, defensibility, why this company is uniquely positioned to win, and the risk of not pursuing it. Consider AI-native SaaS, customer-facing copilots, agentic workflows, marketplaces, subscriptions, premium services, data products, advisory systems, and industry-specific assistants where relevant.

## PHASE 7 — Prioritized Strategic Recommendations

Select the TOP 3 internal innovations and TOP 3 external innovations from the opportunity map.

For every recommendation include leverage, ROI potential, ease of execution, expected impact, urgency, roadmap, short-term wins, long-term value, revenue or cost implications, and the risks of waiting.

## PHASE 8 — Strategic Urgency Brief

Write a concise, high-conviction executive brief explaining why the company must innovate now, which startup threats matter most, which customer expectations are changing, what happens if adoption is delayed, which bets matter most, and which opportunities could become new revenue categories or company-defining products.

## PHASE 9 — Three New Venture Concepts

Using the company intelligence, market research, vector-memory evidence, and opportunity map, create exactly THREE materially different venture concepts that the company could launch or incubate. The concepts may be SaaS, software-enabled services, hardware, wearables, physical products, marketplaces, subscriptions, or hybrid businesses.

For each venture include:

- Name and short positioning statement
- Target customer and urgent problem
- Product form and core experience
- Why now and evidence of demand
- Why {{company_name}} can uniquely win
- Competitive alternatives and defensibility
- Business model, pricing hypothesis, and revenue potential
- MVP scope and 30/60/90-day validation plan
- Key risks, kill criteria, and leading indicators
- Initial GTM channel, message, and CTA

Rank the three ventures using demand, strategic fit, speed to validate, monetization, defensibility, and execution risk. Make a clear recommendation for the first venture to test.

## PHASE 10 — Landing Pages for the Three Ventures

Create a complete, self-contained HTML landing page for each venture. Do not only describe the page in prose. Each page must include:

- A clear title and meta description
- Hero headline, subheadline, primary CTA, and supporting proof or stat
- Problem, solution, key benefits, features, how it works, pricing hypothesis, FAQ, and final CTA
- Responsive styling, accessible semantic HTML, and realistic copy grounded in the research
- A simple form or CTA interaction that is clearly marked as a prototype where it is not connected

Save each page as a real file using a stable slug, for example <venture-slug>-landing.html.

## PHASE 11 — Ad Campaigns for the Three Ventures

Create one launch-ready campaign brief per venture. Each brief must include:

- Campaign objective and conversion event
- Audience, ICP, geography, awareness stage, and targeting logic
- Channel mix and why each channel fits
- Three distinct copy variants with headline, primary text, CTA, and angle
- Creative direction, formats, hooks, and visual requirements
- Budget and test allocation for an initial three-day or otherwise justified test
- KPIs, measurement plan, attribution assumptions, optimization rules, and next action

Save each brief as ad-campaign-<venture-slug>.md.

## PHASE 12 — Social Content and Image-Generated Creative

Create a complete social content package for the highest-priority venture:

- A four-slide carousel with hook, problem/insight, solution/proof, and CTA
- Slide copy, visual direction, caption, hashtags or keywords where appropriate, audience, platform, and test variation
- At least three alternate hooks and a reason for the selected hook

Use the installed image-generation skill/tool to actually generate finished visual assets for the campaign. Do not merely write image prompts. Generate at least one usable visual asset per venture and attach the actual PNG/JPG/WebP files. Review generated assets for legibility, brand fit, factual accuracy, accessibility, and obvious generation artifacts. If the image-generation tool is unavailable, state the exact blocker and do not claim that image assets were created.

## FINAL DELIVERABLE ORDER

Return and attach the deliverables in this order:

1. Executive Summary
2. Company Intelligence Overview
3. Customer & Market Segmentation
4. Moat & Competitive Positioning
5. AI Risk Mapping
6. Emerging Startup Threat Landscape
7. Top 10 AI Innovation Opportunities
8. Top 3 Internal Innovation Recommendations
9. Top 3 External Innovation Recommendations
10. Strategic Urgency Brief
11. Final Strategic Conclusion & Next Steps
12. Three venture concept summaries and prioritization
13. Three landing-page HTML files
14. Three ad-campaign Markdown files
15. Four-slide social carousel/content package
16. Generated image assets

## IMPORTANT: Mandatory Artifact Attachment Rule

Whenever you generate reports, images, code files, landing pages, diagrams, or any other artifact for this issue, you MUST attach every artifact to the issue before completing the work.

Upload every output file individually through the Paperclip issue attachment API:

    curl -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues/$PAPERCLIP_TASK_ID/attachments" \\
      -H "Authorization: Bearer $PAPERCLIP_API_KEY" \\
      -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \\
      -F "file=@<artifact-path>" \\
      -F "title=<artifact-title>"

Do this for EVERY output file. Never leave artifacts only on disk, in a workspace, in a comment, or as an issue document. Issue documents are not a substitute for downloadable attachments.

Before marking the issue done:

1. Verify every artifact exists and is readable.
2. Upload every artifact to the current issue.
3. Confirm the attachments appear in the issue Output/Attachments tab.
4. Post a final comment listing every attachment by exact filename and link.

Never mark the issue done while any required artifact is missing or unattached. If an artifact cannot be attached, keep the issue in progress or blocked and explain the exact blocker.

Do not execute a second phase such as product building, UI prototyping, deployment, external publishing, or paid spend unless it is explicitly requested in this task. This workflow's required launch-pack artifacts are the exception and must be completed now.`;

export interface MarketingInnovationWorkflowContext {
  companyId: string;
  companyName: string;
  website?: string | null;
  importantLinks?: readonly string[] | null;
  documentNames?: readonly string[] | null;
}

function displayValue(value: string | null | undefined, fallback: string) {
  const normalized = value?.trim();
  return normalized || fallback;
}

function displayList(values: readonly string[] | null | undefined, fallback: string) {
  const entries = (values ?? []).map((value) => value.trim()).filter(Boolean);
  return entries.length > 0 ? entries.join("\n") : fallback;
}

export function buildMarketingInnovationWorkflowVariables(
  context: MarketingInnovationWorkflowContext,
): RoutineVariable[] {
  return [
    {
      name: "company_name",
      label: "Company name",
      type: "text",
      defaultValue: displayValue(context.companyName, "Unnamed company"),
      required: true,
      options: [],
    },
    {
      name: "company_website",
      label: "Company website",
      type: "text",
      defaultValue: displayValue(context.website, "No website supplied"),
      required: true,
      options: [],
    },
    {
      name: "company_id",
      label: "Paperclip company ID",
      type: "text",
      defaultValue: context.companyId,
      required: true,
      options: [],
    },
    {
      name: "important_links",
      label: "Important links",
      type: "textarea",
      defaultValue: displayList(context.importantLinks, "No important links supplied"),
      required: true,
      options: [],
    },
    {
      name: "uploaded_documents",
      label: "Uploaded onboarding documents",
      type: "textarea",
      defaultValue: displayList(context.documentNames, "No uploaded documents supplied"),
      required: true,
      options: [],
    },
  ];
}
