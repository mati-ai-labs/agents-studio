import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MARKETING_INNOVATION_WORKFLOW_DESCRIPTION,
  MARKETING_INNOVATION_WORKFLOW_TITLE,
  buildMarketingInnovationWorkflowContent,
  type AdapterEnvironmentTestResult,
} from "@paperclipai/shared";
import { useLocation, useNavigate, useParams } from "@/lib/router";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { companiesApi } from "../api/companies";
import { goalsApi } from "../api/goals";
import { agentsApi } from "../api/agents";
import { approvalsApi } from "../api/approvals";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { routinesApi } from "../api/routines";
import { queryKeys } from "../lib/queryKeys";
import { Dialog, DialogPortal } from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import {
  extractModelName,
  extractProviderIdWithFallback
} from "../lib/model-utils";
import { getUIAdapter } from "../adapters";
import { listUIAdapters } from "../adapters";
import { isVisualAdapterChoice } from "../adapters/metadata";
import { useDisabledAdaptersSync } from "../adapters/use-disabled-adapters";
import { useAdapterCapabilities } from "../adapters/use-adapter-capabilities";
import { getAdapterDisplay } from "../adapters/adapter-display-registry";
import { defaultCreateValues } from "./agent-config-defaults";
import { parseOnboardingGoalInput } from "../lib/onboarding-goal";
import { composeCeoInstructions } from "../lib/ceo-instructions";
import {
  buildOnboardingIssuePayload,
  buildOnboardingProjectPayload,
  selectDefaultCompanyGoalId,
  selectReusableOnboardingProject,
} from "../lib/onboarding-launch";
import { buildNewAgentRuntimeConfig } from "../lib/new-agent-runtime-config";
import { DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX } from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";
import { DEFAULT_OPENCODE_LOCAL_MODEL, isValidOpenCodeModelId } from "@paperclipai/adapter-opencode-local";
import { resolveRouteOnboardingOptions } from "../lib/onboarding-route";
import {
  registerMarketingStackAgents,
  startMarketingStackImport,
} from "../lib/marketing-stack-import";
import productDesignAgentInstructions from "./marketing-stack-prompts/product-design.AGENTS.md?raw";
import marketResearchAgentInstructions from "./marketing-stack-prompts/market-research.AGENTS.md?raw";
import marketIntelligenceAgentInstructions from "./marketing-stack-prompts/market-intelligence.AGENTS.md?raw";
import carouselSocialAgentInstructions from "./marketing-stack-prompts/carousel-social.AGENTS.md?raw";
import { AsciiArtAnimation } from "./AsciiArtAnimation";
import { FrontDoor } from "./FrontDoor";
import { AgentCapsule } from "./AgentCapsule";
import { Badge } from "@/components/ui/badge";
import {
  Building2,
  Bot,
  ListTodo,
  ArrowLeft,
  ArrowRight,
  Sparkles,
  Check,
  Loader2,
  ChevronDown,
  X,
  Upload
} from "lucide-react";

type Step = 0 | 1 | 2 | 3 | 4 | 5;
// Plugin/external adapters use arbitrary type ids, so this mirrors the master
// wizard's registry-driven approach rather than a fixed union.
type AdapterType = string;

const DEFAULT_TASK_TITLE = "{{company_name}} Innovation Intelligence Report";
const DEFAULT_TASK_DESCRIPTION = `## Company Innovation Intelligence Report

# Target Company Website: {{company_website}}

You are the Lead Innovation Strategy Agent operating inside an AI-native venture studio.

Your responsibility is to deeply analyze this company, understand its business model and operational structure, identify how AI and agentic systems may disrupt its market, and propose high-leverage AI-powered innovation opportunities that can help the company defend and expand its market position.

Your output should feel like a strategic innovation report prepared by an elite AI innovation studio and venture builder.

Complete the following phases sequentially.

***

# PHASE 1 — Company Intelligence Scan

Research the target company thoroughly.

Analyze:

- What the company does
- How they make money
- Their core products/services
- Their pricing and monetization structure
- Their business model
- Their customer acquisition model
- Their go-to-market strategy
- Their delivery model
- Their operational workflows
- Their technology stack (if inferable)
- Their team structure (if inferable)
- Their strategic positioning in the market

Map how the company currently delivers value to customers.

Identify:

- Core differentiators
- Strengths
- Weaknesses
- Operational bottlenecks
- Areas of inefficiency
- Dependency risks
- Workflow friction points

Then summarize the company’s business model in plain language.

***

# PHASE 2 — Customer & Market Segmentation

Identify and clearly define:

- Core customer segments
- Revenue-driving customer profiles
- Primary operating modes

Examples:

- B2B
- B2C
- Enterprise
- SMB
- Marketplace
- SaaS
- Services
- Subscription
- Usage-based
- Transactional
- Hybrid models

For each segment explain:

- Who they serve
- What problem they solve
- Why customers buy from them
- How important this segment is to revenue
- The level of defensibility of that segment in the AI era

Then identify:

- Which customer segments are most vulnerable to AI disruption
- Which segments are most valuable long-term
- Which segments the company should expand into

***

# PHASE 3 — Moat & Competitive Positioning Analysis

Identify the company’s core moat(s).

Analyze:

- Distribution advantages
- Brand trust
- Existing customer relationships
- Proprietary data
- Workflow lock-in
- Operational excellence
- Network effects
- Industry expertise
- Community advantages
- Regulatory positioning
- Technology differentiation

Then answer:

- Which moats strengthen in the AI era?
- Which moats weaken in the AI era?
- Which moats become commoditized due to AI?
- What new moats should the company build now?

***

# PHASE 4 — AI-Era Risk Mapping

Given the current wave of AI transformation and agentic innovation, identify the top risks this company faces if it fails to innovate aggressively.

Think across:

## Operational Risks

- Manual workflows
- Human-heavy execution
- Inefficient coordination
- Slow delivery systems
- Poor internal knowledge management
- Scalability bottlenecks

## Market Risks

- Pricing compression
- AI commoditization
- Lower barriers to entry
- Faster competitors
- Customer expectation shifts

## Competitive Risks

- AI-native entrants
- Agentic platforms
- Vertical AI startups
- Workflow automation products
- AI copilots replacing service layers

## Strategic Risks

- Failure to adapt
- Weak AI positioning
- Lack of proprietary data strategy
- Failure to build distribution
- Dependence on outdated workflows

Be highly specific to this company and industry.

Do not provide generic AI commentary.

***

# PHASE 5 — Emerging Startup Threat Landscape

Research emerging startups, recently funded ventures, and AI-native companies operating in this company’s space.

Identify:

- Startup name
- Funding stage (if available)
- What they are building
- Which workflow or market segment they are attacking
- Why their approach matters
- Why they are dangerous to incumbent companies
- What AI or agentic advantage they possess

Then explain:

- How these startups could disrupt the target company
- Which parts of the company are most exposed
- Which market segments are most vulnerable
- Which future customer expectations these startups are creating

***

# PHASE 6 — AI Innovation Opportunity Map

Generate a prioritized list of the TOP 10 AI-powered innovation opportunities for this company.

Split them into two categories:

***

## A. Internal Innovation Opportunities

(Operational optimization using AI and agentic systems)

Examples:

- AI sales agents
- AI operations copilots
- AI customer support systems
- AI workflow orchestration
- AI marketing automation
- AI reporting and analytics
- AI knowledge management
- AI employee copilots
- AI onboarding systems
- AI recruiting agents
- AI customer success systems

For each opportunity include:

- Problem being solved
- Workflow impact
- Cost reduction potential
- Speed improvement potential
- Scalability impact
- Estimated implementation complexity
- Strategic importance

***

## B. External Innovation Opportunities

(New products, services, features, or revenue streams)

Examples:

- AI-native SaaS products
- Customer-facing copilots
- Agentic workflow platforms
- AI-powered marketplaces
- AI subscriptions
- AI-enabled premium services
- Data intelligence products
- AI advisory systems
- Industry-specific AI assistants
- AI automation platforms

For each opportunity include:

- Revenue potential
- Strategic alignment
- Market demand
- Competitive advantage
- Long-term defensibility
- Why the company is uniquely positioned to win
- Risks of not pursuing it

***

# PHASE 7 — Prioritized Strategic Recommendations

From all opportunities identified above, select:

# TOP 3 INTERNAL INNOVATIONS

For each provide:

- Why this is high leverage
- ROI potential
- Ease of execution
- Expected operational impact
- Strategic urgency
- Recommended implementation roadmap
- Short-term wins vs long-term value

***

# TOP 3 EXTERNAL INNOVATIONS

For each provide:

- Why this is a meaningful market opportunity
- Revenue expansion potential
- Strategic defensibility
- AI-native differentiation potential
- Alignment with the company’s current strengths
- Why this matters now
- Risks of waiting too long

***

# PHASE 8 — Strategic Urgency Brief

Write a concise but high-conviction executive brief explaining:

- Why this company must innovate now
- Which startup threats matter most
- Which customer expectations are changing fastest
- What happens if the company delays AI adoption
- Which innovation bets are the most strategically important
- Which opportunities could create entirely new revenue categories
- Which opportunities could become future company-defining products

This section should read like a venture-backed strategic transformation memo.

***

# FINAL DELIVERABLE FORMAT

Structure the final report in this exact order:

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

***

# OUTPUT QUALITY REQUIREMENTS

The output must:

- Be highly strategic and specific
- Avoid generic AI buzzwords
- Focus on real workflows and business leverage
- Think like a venture studio, not a consultant
- Focus on transformation, defensibility, and new revenue creation
- Tie recommendations directly to competitive pressure and market shifts
- Prioritize innovation opportunities with real business outcomes

The report should feel sophisticated enough to present directly to:

- CEOs
- PE firms
- Search funds
- Venture partners
- Strategy teams
- Corporate innovation groups

***

# NEXT PHASE (DO NOT EXECUTE YET)

Once this report is complete, the next phase will involve:

- Creating product concepts
- Designing AI-native workflows
- Creating UI/UX prototypes
- Building landing pages
- Developing GTM messaging
- Creating investor-style opportunity decks
- Designing technical architecture concepts
- Creating implementation roadmaps
`;

function buildCompanyResearchTaskDescription(input: {
  companyId: string;
  website: string;
  importantLinks: string[];
  documentNames: string[];
}) {
  return DEFAULT_TASK_DESCRIPTION.replaceAll(
    "{{company_website}}",
    input.website || "No website supplied; infer from the company context and available sources."
  );
}

const MARKETING_STACK_AGENT_METADATA = [
  {
    name: "Product Design Agent",
    capabilities:
      "Reads the company's knowledge base and vector memory, studies the market, and proposes new product opportunities across software, hardware, services, and physical products.",
  },
  {
    name: "Market Research Agent",
    capabilities:
      "Researches current markets, competitors, customer segments, trends, pricing, and evidence-backed opportunities.",
  },
  {
    name: "Market Intelligence Agent",
    capabilities:
      "Combines the company's PostgreSQL vector memory with current market evidence to estimate product demand and recommend positioning and priorities.",
  },
  {
    name: "Carousel Social Media Agent",
    capabilities:
      "Creates research-driven social media carousels, tests hooks and CTAs, and improves content using engagement and conversion feedback.",
  },
] as const;

/**
 * These are the canonical Marketing Stack agent bundles. They are copied from
 * the working Etiq company agents so onboarding uses the same detailed
 * AGENTS.md instructions and the same skill wiring everywhere.
 */
const ETIQ_MARKETING_STACK_AGENT_CONFIG: Record<
  string,
  { instructions: string; desiredSkillRefs: readonly string[] }
> = {
  "Product Design Agent": {
    instructions: productDesignAgentInstructions,
    desiredSkillRefs: [
      "paperclipai/paperclip/caveman",
      "paperclipai/paperclip/product-design",
      "paperclipai/paperclip/market-research-agent",
      "paperclipai/paperclip/para-memory-files",
      "paperclipai/paperclip/git-guardrails-claude-code",
      "paperclipai/paperclip/diagnose",
      "paperclipai/paperclip/grill-me",
      "paperclipai/paperclip/grill-with-docs",
      "paperclipai/paperclip/handoff",
      "paperclipai/paperclip/paperclip",
      "paperclipai/paperclip/paperclip-converting-plans-to-tasks",
      "paperclipai/paperclip/triage",
      "paperclipai/paperclip/zoom-out",
      "paperclipai/paperclip/minimax-web-search",
      "coreyhaines31/marketingskills/competitor-profiling",
      "coreyhaines31/marketingskills/product-marketing",
      "coreyhaines31/marketingskills/analytics",
      "coreyhaines31/marketingskills/marketing-psychology",
      "coreyhaines31/marketingskills/prospecting",
      "coreyhaines31/marketingskills/marketing-ideas",
    ],
  },
  "Market Research Agent": {
    instructions: marketResearchAgentInstructions,
    desiredSkillRefs: [
      "paperclipai/paperclip/caveman",
      "paperclipai/paperclip/ckm-banner-design",
      "paperclipai/paperclip/ckm-brand",
      "paperclipai/paperclip/ckm-design",
      "paperclipai/paperclip/ckm-design-system",
      "paperclipai/paperclip/ckm-slides",
      "paperclipai/paperclip/ckm-ui-styling",
      "paperclipai/paperclip/diagnose",
      "paperclipai/paperclip/diagnose-why-work-stopped",
      "paperclipai/paperclip/edit-article",
      "paperclipai/paperclip/git-guardrails-claude-code",
      "paperclipai/paperclip/gmail",
      "paperclipai/paperclip/google-workspace-mcp",
      "paperclipai/paperclip/granola",
      "paperclipai/paperclip/grill-me",
      "paperclipai/paperclip/grill-with-docs",
      "paperclipai/paperclip/handoff",
      "paperclipai/paperclip/improve-codebase-architecture",
      "paperclipai/paperclip/jira",
      "paperclipai/paperclip/market-research-agent",
      "paperclipai/paperclip/migrate-to-shoehorn",
      "paperclipai/paperclip/minimax-web-search",
      "paperclipai/paperclip/obsidian-vault",
      "paperclipai/paperclip/paperclip",
      "paperclipai/paperclip/paperclip-converting-plans-to-tasks",
      "paperclipai/paperclip/paperclip-create-agent",
      "paperclipai/paperclip/paperclip-create-plugin",
      "paperclipai/paperclip/paperclip-dev",
      "paperclipai/paperclip/para-memory-files",
      "paperclipai/paperclip/prototype",
      "paperclipai/paperclip/quickbooks",
      "paperclipai/paperclip/scaffold-exercises",
      "paperclipai/paperclip/setup-matt-pocock-skills",
      "paperclipai/paperclip/setup-pre-commit",
      "paperclipai/paperclip/sibyl-memory",
      "paperclipai/paperclip/tdd",
      "paperclipai/paperclip/teach",
      "paperclipai/paperclip/team-organiser",
      "paperclipai/paperclip/terminal-bench-loop",
      "paperclipai/paperclip/to-issues",
      "paperclipai/paperclip/to-prd",
      "paperclipai/paperclip/triage",
      "paperclipai/paperclip/ui-ux-pro-max",
      "paperclipai/paperclip/vector-memory",
      "paperclipai/paperclip/write-a-skill",
      "paperclipai/paperclip/zoom-out",
      "coreyhaines31/marketingskills/ai-seo",
      "coreyhaines31/marketingskills/ab-testing",
      "coreyhaines31/marketingskills/co-marketing",
      "coreyhaines31/marketingskills/analytics",
      "coreyhaines31/marketingskills/competitors",
      "coreyhaines31/marketingskills/competitor-profiling",
      "coreyhaines31/marketingskills/content-strategy",
      "coreyhaines31/marketingskills/marketing-ideas",
      "coreyhaines31/marketingskills/marketing-psychology",
      "coreyhaines31/marketingskills/product-marketing",
      "coreyhaines31/marketingskills/prospecting",
      "coreyhaines31/marketingskills/social",
    ],
  },
  "Market Intelligence Agent": {
    instructions: marketIntelligenceAgentInstructions,
    desiredSkillRefs: [
      "paperclipai/paperclip/caveman",
      "paperclipai/paperclip/ckm-banner-design",
      "paperclipai/paperclip/ckm-brand",
      "paperclipai/paperclip/ckm-design",
      "paperclipai/paperclip/ckm-design-system",
      "paperclipai/paperclip/ckm-slides",
      "paperclipai/paperclip/ckm-ui-styling",
      "paperclipai/paperclip/diagnose",
      "paperclipai/paperclip/diagnose-why-work-stopped",
      "paperclipai/paperclip/edit-article",
      "paperclipai/paperclip/git-guardrails-claude-code",
      "paperclipai/paperclip/gmail",
      "paperclipai/paperclip/google-workspace-mcp",
      "paperclipai/paperclip/granola",
      "paperclipai/paperclip/grill-me",
      "paperclipai/paperclip/grill-with-docs",
      "paperclipai/paperclip/handoff",
      "paperclipai/paperclip/improve-codebase-architecture",
      "paperclipai/paperclip/jira",
      "paperclipai/paperclip/market-research-agent",
      "paperclipai/paperclip/migrate-to-shoehorn",
      "paperclipai/paperclip/minimax-web-search",
      "paperclipai/paperclip/obsidian-vault",
      "paperclipai/paperclip/paperclip",
      "paperclipai/paperclip/paperclip-converting-plans-to-tasks",
      "paperclipai/paperclip/paperclip-create-agent",
      "paperclipai/paperclip/paperclip-create-plugin",
      "paperclipai/paperclip/paperclip-dev",
      "paperclipai/paperclip/para-memory-files",
      "paperclipai/paperclip/prototype",
      "paperclipai/paperclip/quickbooks",
      "paperclipai/paperclip/scaffold-exercises",
      "paperclipai/paperclip/setup-matt-pocock-skills",
      "paperclipai/paperclip/setup-pre-commit",
      "paperclipai/paperclip/sibyl-memory",
      "paperclipai/paperclip/tdd",
      "paperclipai/paperclip/teach",
      "paperclipai/paperclip/team-organiser",
      "paperclipai/paperclip/terminal-bench-loop",
      "paperclipai/paperclip/to-issues",
      "paperclipai/paperclip/to-prd",
      "paperclipai/paperclip/triage",
      "paperclipai/paperclip/ui-ux-pro-max",
      "paperclipai/paperclip/vector-memory",
      "paperclipai/paperclip/write-a-skill",
      "paperclipai/paperclip/zoom-out",
      "url/clawhub-ai/d891ad2b2d/tiktok-app-marketing",
      "coreyhaines31/marketingskills/social",
      "coreyhaines31/marketingskills/seo-audit",
      "coreyhaines31/marketingskills/prospecting",
      "coreyhaines31/marketingskills/product-marketing",
      "coreyhaines31/marketingskills/marketing-psychology",
      "coreyhaines31/marketingskills/directory-submissions",
      "coreyhaines31/marketingskills/marketing-ideas",
      "coreyhaines31/marketingskills/competitors",
      "coreyhaines31/marketingskills/competitor-profiling",
      "coreyhaines31/marketingskills/co-marketing",
      "coreyhaines31/marketingskills/analytics",
      "coreyhaines31/marketingskills/ab-testing",
    ],
  },
  "Carousel Social Media Agent": {
    instructions: carouselSocialAgentInstructions,
    desiredSkillRefs: [
      "paperclipai/paperclip/caveman",
      "paperclipai/paperclip/ckm-banner-design",
      "paperclipai/paperclip/ckm-brand",
      "paperclipai/paperclip/ckm-design",
      "paperclipai/paperclip/ckm-design-system",
      "paperclipai/paperclip/ckm-slides",
      "paperclipai/paperclip/ckm-ui-styling",
      "paperclipai/paperclip/diagnose",
      "paperclipai/paperclip/diagnose-why-work-stopped",
      "paperclipai/paperclip/edit-article",
      "paperclipai/paperclip/git-guardrails-claude-code",
      "paperclipai/paperclip/gmail",
      "paperclipai/paperclip/google-workspace-mcp",
      "paperclipai/paperclip/granola",
      "paperclipai/paperclip/grill-me",
      "paperclipai/paperclip/grill-with-docs",
      "paperclipai/paperclip/handoff",
      "paperclipai/paperclip/improve-codebase-architecture",
      "paperclipai/paperclip/jira",
      "paperclipai/paperclip/market-research-agent",
      "paperclipai/paperclip/migrate-to-shoehorn",
      "paperclipai/paperclip/minimax-web-search",
      "paperclipai/paperclip/obsidian-vault",
      "paperclipai/paperclip/paperclip",
      "paperclipai/paperclip/paperclip-converting-plans-to-tasks",
      "paperclipai/paperclip/paperclip-create-agent",
      "paperclipai/paperclip/paperclip-create-plugin",
      "paperclipai/paperclip/paperclip-dev",
      "paperclipai/paperclip/para-memory-files",
      "paperclipai/paperclip/prototype",
      "paperclipai/paperclip/quickbooks",
      "paperclipai/paperclip/scaffold-exercises",
      "paperclipai/paperclip/setup-matt-pocock-skills",
      "paperclipai/paperclip/setup-pre-commit",
      "paperclipai/paperclip/sibyl-memory",
      "paperclipai/paperclip/tdd",
      "paperclipai/paperclip/teach",
      "paperclipai/paperclip/team-organiser",
      "paperclipai/paperclip/terminal-bench-loop",
      "paperclipai/paperclip/to-issues",
      "paperclipai/paperclip/to-prd",
      "paperclipai/paperclip/triage",
      "paperclipai/paperclip/ui-ux-pro-max",
      "paperclipai/paperclip/vector-memory",
      "paperclipai/paperclip/write-a-skill",
      "paperclipai/paperclip/zoom-out",
      "url/clawhub-ai/d891ad2b2d/tiktok-app-marketing",
      "coreyhaines31/marketingskills/ab-testing",
      "coreyhaines31/marketingskills/competitor-profiling",
      "coreyhaines31/marketingskills/content-strategy",
      "coreyhaines31/marketingskills/image",
      "coreyhaines31/marketingskills/marketing-ideas",
      "coreyhaines31/marketingskills/marketing-psychology",
      "coreyhaines31/marketingskills/social",
    ],
  },
};

const MARKETING_STACK_AGENTS = MARKETING_STACK_AGENT_METADATA.map((definition) => ({
  ...definition,
  ...ETIQ_MARKETING_STACK_AGENT_CONFIG[definition.name],
  needsTikTokSkill: false as const,
  needsProductIdeationSkills: false as const,
}));

const MARKETING_STACK_ROUTINES = [
  {
    title: "Product Design",
    assigneeName: "Product Design Agent",
    description: `Purpose
Analyze the company's current products, assets, customer problems, distribution advantages, and market position, then propose new product opportunities worth launching next.

Routing
This routine must be owned by the Product Design Agent.

Execution instructions
1. Start with company memory first. Read vector memory using the current Paperclip company ID as user_id.
2. Reconstruct the company's current offerings, strengths, customer pains, constraints, and prior findings from memory, company docs, and the onboarding research issue.
3. Research the live market and competitor landscape online using current sources.
4. Generate multiple new product ideas across software, hardware, services, physical goods, and hybrid offers where relevant.
5. Use jobs-to-be-done, opportunity-solution-tree thinking, customer pain, differentiation, monetization, company fit, and validation speed to rank the ideas.
6. Recommend the strongest ideas with:
   - target customer
   - problem
   - product form
   - why now
   - why this company can win
   - risks
   - validation plan
7. Persist durable opportunity findings back to vector memory with user_id equal to the company ID.

Skill guidance
- Primary: brainstorm-ideas
- Supporting: jobs-to-be-done, opportunity-solution-tree, customer-research, competitor-profiling, analytics, product-marketing, pricing, marketing-psychology

Output
Produce a ranked product opportunity memo with at least three serious ideas and a clear recommendation for what to test first.`,
  },
  {
    title: "Competitor Research",
    assigneeName: "Market Research Agent",
    description: `Purpose
Continuously study the company's direct competitors, substitutes, market moves, positioning shifts, and whitespace so the company can sharpen positioning and strategic messaging.

Routing
This routine must be owned by the Market Research Agent.

Execution instructions
1. Read company memory and current positioning before starting external research.
2. Identify the active competitor set, substitutes, adjacent alternatives, and emergent players.
3. Review current websites, product surfaces, public launches, messaging, pricing, reviews, case studies, content, and proof points.
4. Compare the company against competitors on ICP, product shape, positioning, pricing, trust signals, strengths, weaknesses, and likely buyer objections.
5. Highlight where the company should reposition, differentiate harder, or avoid crowded claims.
6. Record durable competitor facts and dated market changes back into vector memory using the company ID as user_id.

Skill guidance
- Primary: paperclipai/paperclip/market-research-agent
- Supporting: competitor-profiling, competitors, customer-research, analytics, product-marketing, pricing

Output
Produce a competitor intelligence brief with a positioning adjustment section, risk section, and specific messaging or GTM recommendations.`,
  },
  {
    title: "Content Creation",
    assigneeName: "Carousel Social Media Agent",
    description: `Purpose
Create a platform-ready 4-slide carousel based on the company's products, goals, market context, and current strategic priorities.

Routing
This routine must be owned by the Carousel Social Media Agent.

Execution instructions
1. Read the latest company memory, product context, market intelligence, and current goals before generating content.
2. Choose one strong audience-specific angle tied to company goals.
3. Research current market conversation and competitor or creator patterns relevant to that angle.
4. Generate multiple hooks, choose the best one, and justify it briefly.
5. Produce a complete 4-slide carousel:
   - slide 1: hook
   - slide 2: insight/problem
   - slide 3: solution/proof/value
   - slide 4: CTA
6. Also provide caption, visual direction, target platform, target audience, and one test variation.
7. Keep output aligned with brand and current company strategy.

Skill guidance
- Primary: tiktok-app-marketing for TikTok-first or short-form social framing
- Supporting: social, copywriting, content-strategy, ad-creative, image, video, marketing-psychology, ckm:brand

Output
Deliver the finished 4-slide content package, not just notes.`,
  },
  {
    title: MARKETING_INNOVATION_WORKFLOW_TITLE,
    assigneeName: "Market Research Agent",
    description: MARKETING_INNOVATION_WORKFLOW_DESCRIPTION,
    trigger: {
      kind: "webhook" as const,
      label: "Innovation launch pack webhook",
      enabled: true,
      signingMode: "bearer" as const,
    },
    materializeForCompany: true as const,
  },
] as const;

const MISSION_PROMPT_CHIPS = [
  "Build a SaaS product",
  "Scale a content business",
  "Launch a marketplace"
];

function buildMissionFromQuestionnaire(q1: string, q2: string, q3: string, q4: string): string {
  const parts: string[] = [];
  if (q1.trim()) parts.push(q1.trim());
  if (q2.trim()) parts.push(`We serve ${q2.trim().toLowerCase()}.`);
  if (q3.trim()) parts.push(`Our biggest challenge is ${q3.trim().toLowerCase()}.`);
  if (q4.trim()) parts.push(`Success looks like ${q4.trim().toLowerCase()}.`);
  return parts.join(" ");
}

const ONBOARDING_STORAGE_KEY = "paperclip-onboarding-state";
const INCOMPLETE_ONBOARDING_STATE_MESSAGE =
  "Onboarding state is incomplete. Please restart onboarding and try again.";

function loadSavedState(): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(ONBOARDING_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function OnboardingWizard() {
  const {
    onboardingOpen,
    onboardingOptions,
    closeOnboarding,
    onboardingRouteDismissed: routeDismissed,
    setOnboardingRouteDismissed: setRouteDismissed,
  } = useDialog();
  const { companies, setSelectedCompanyId, loading: companiesLoading } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();

  // Support opening the wizard from a route (e.g. /onboarding or an existing
  // company's "add agent" entry point) in addition to the dialog context.
  const routeOnboardingOptions =
    companyPrefix && companiesLoading
      ? null
      : resolveRouteOnboardingOptions({
          pathname: location.pathname,
          companyPrefix,
          companies,
        });
  const effectiveOnboardingOpen =
    onboardingOpen || (routeOnboardingOptions !== null && !routeDismissed);
  const effectiveOnboardingOptions = onboardingOpen
    ? onboardingOptions
    : routeOnboardingOptions ?? {};

  // Sync disabled adapter types only when the wizard is visible. The wizard is
  // mounted globally, including on /auth, where protected adapter routes are
  // expected to reject signed-out browsers.
  const disabledTypes = useDisabledAdaptersSync({ enabled: effectiveOnboardingOpen });

  const initialStep = effectiveOnboardingOptions.initialStep ?? 0;
  const existingCompanyId = effectiveOnboardingOptions.companyId;

  // Restore saved state from localStorage (read once on mount)
  const saved = useMemo(loadSavedState, []);

  const [step, setStep] = useState<Step>((saved?.step as Step) ?? initialStep);
  const [onboardingPath, setOnboardingPath] = useState<"create" | "grow" | null>((saved?.onboardingPath as "create" | "grow" | null) ?? null);

  // "Grow existing" questionnaire fields
  const [growWorkflows, setGrowWorkflows] = useState((saved?.growWorkflows as string) ?? "");
  const [growPainPoints, setGrowPainPoints] = useState((saved?.growPainPoints as string) ?? "");
  const [growAutomate, setGrowAutomate] = useState((saved?.growAutomate as string) ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");

  // Step 1
  const [companyName, setCompanyName] = useState((saved?.companyName as string) ?? "");
  const [companyGoal, setCompanyGoal] = useState((saved?.companyGoal as string) ?? "");
  const [companyWebsite, setCompanyWebsite] = useState((saved?.companyWebsite as string) ?? "");
  const [companyImportantLinks, setCompanyImportantLinks] = useState(
    (saved?.companyImportantLinks as string) ?? "",
  );
  const [companyDocuments, setCompanyDocuments] = useState<File[]>([]);
  const [addMarketingStack, setAddMarketingStack] = useState(
    (saved?.addMarketingStack as boolean) ?? false,
  );
  const [missionPath, setMissionPath] = useState<"direct" | "questionnaire" | null>((saved?.missionPath as "direct" | "questionnaire" | null) ?? null);
  const [missionConfirmed, setMissionConfirmed] = useState((saved?.missionConfirmed as boolean) ?? false);
  // Questionnaire answers
  const [q1, setQ1] = useState((saved?.q1 as string) ?? ""); // What do you do?
  const [q2, setQ2] = useState((saved?.q2 as string) ?? ""); // Who do you serve?
  const [q3, setQ3] = useState((saved?.q3 as string) ?? ""); // Biggest bottleneck?
  const [q4, setQ4] = useState((saved?.q4 as string) ?? ""); // What would success look like?

  // Step 2
  const [agentName, setAgentName] = useState((saved?.agentName as string) ?? "Chief of staff");
  const [adapterType, setAdapterType] = useState<AdapterType>((saved?.adapterType as AdapterType) ?? "claude_local");
  const [cwd, setCwd] = useState((saved?.cwd as string) ?? "");
  const [model, setModel] = useState((saved?.model as string) ?? "");
  const [command, setCommand] = useState((saved?.command as string) ?? "");
  const [args, setArgs] = useState((saved?.args as string) ?? "");
  const [url, setUrl] = useState((saved?.url as string) ?? "");
  const [adapterEnvResult, setAdapterEnvResult] =
    useState<AdapterEnvironmentTestResult | null>(null);
  const [adapterEnvError, setAdapterEnvError] = useState<string | null>(null);
  const [adapterEnvLoading, setAdapterEnvLoading] = useState(false);
  const [forceUnsetAnthropicApiKey, setForceUnsetAnthropicApiKey] =
    useState(false);
  const [unsetAnthropicLoading, setUnsetAnthropicLoading] = useState(false);
  const [showMoreAdapters, setShowMoreAdapters] = useState(false);

  // Step 3
  const [taskTitle, setTaskTitle] = useState(DEFAULT_TASK_TITLE);
  const [taskDescription, setTaskDescription] = useState(
    DEFAULT_TASK_DESCRIPTION
  );

  // Auto-grow textarea for task description
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const autoResizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, []);

  // Created entity IDs — pre-populate from existing company when skipping step 1
  const [createdCompanyId, setCreatedCompanyId] = useState<string | null>(
    existingCompanyId ?? (saved?.createdCompanyId as string) ?? null
  );
  const [createdCompanyPrefix, setCreatedCompanyPrefix] = useState<
    string | null
  >((saved?.createdCompanyPrefix as string) ?? null);
  const [createdAgentId, setCreatedAgentId] = useState<string | null>((saved?.createdAgentId as string) ?? null);
  const [createdCompanyGoalId, setCreatedCompanyGoalId] = useState<string | null>(
    (saved?.createdCompanyGoalId as string) ?? null
  );
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(
    (saved?.createdProjectId as string) ?? null
  );
  const [createdIssueRef, setCreatedIssueRef] = useState<string | null>(
    (saved?.createdIssueRef as string) ?? null
  );
  const [createdIssueId, setCreatedIssueId] = useState<string | null>(
    (saved?.createdIssueId as string) ?? null
  );
  const [createdResearchIssueId, setCreatedResearchIssueId] = useState<string | null>(
    (saved?.createdResearchIssueId as string) ?? null
  );

  // Reset the route-dismissed flag when navigating to a different path.
  useEffect(() => {
    setRouteDismissed(false);
  }, [location.pathname]);

  // Sync step and company when onboarding opens with explicit options.
  // Only override saved state when explicit options provide values.
  useEffect(() => {
    if (!effectiveOnboardingOpen) return;
    // If explicit options are provided, they take precedence over saved state
    if (effectiveOnboardingOptions.initialStep !== undefined) {
      setStep(effectiveOnboardingOptions.initialStep);
    }
    if (effectiveOnboardingOptions.companyId) {
      setCreatedCompanyId(effectiveOnboardingOptions.companyId);
      setCreatedCompanyPrefix(null);
      setCreatedCompanyGoalId(null);
      setCreatedProjectId(null);
      setCreatedAgentId(null);
      setCreatedIssueRef(null);
      setCreatedIssueId(null);
      setCreatedResearchIssueId(null);
    }
  }, [
    effectiveOnboardingOpen,
    effectiveOnboardingOptions.companyId,
    effectiveOnboardingOptions.initialStep
  ]);

  // Backfill issue prefix for an existing company once companies are loaded.
  useEffect(() => {
    if (!effectiveOnboardingOpen || !createdCompanyId || createdCompanyPrefix) return;
    const company = companies.find((c) => c.id === createdCompanyId);
    if (!company) return;
    setCreatedCompanyPrefix(company.issuePrefix);
    if (taskDescription === DEFAULT_TASK_DESCRIPTION) {
      setTaskTitle(DEFAULT_TASK_TITLE.replaceAll("{{company_name}}", company.name));
      setTaskDescription(buildCompanyResearchTaskDescription({
        companyId: company.id,
        website: company.website ?? "",
        importantLinks: company.importantLinks ?? [],
        documentNames: companyDocuments.map((file) => file.name)
      }));
    }
  }, [
    effectiveOnboardingOpen,
    createdCompanyId,
    createdCompanyPrefix,
    companies,
    companyDocuments,
    taskDescription
  ]);

  // Persist wizard state to localStorage on every change
  useEffect(() => {
    if (!effectiveOnboardingOpen) return;
    const state = {
      step, companyName, companyGoal, missionPath, missionConfirmed,
      q1, q2, q3, q4, agentName, adapterType, cwd, model, command, args, url,
      createdCompanyId, createdCompanyPrefix, createdAgentId,
      createdCompanyGoalId, createdProjectId, createdIssueRef,
      onboardingPath, growWorkflows, growPainPoints, growAutomate,
    };
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(state));
  }, [
    effectiveOnboardingOpen, step, companyName, companyGoal, missionPath, missionConfirmed,
    q1, q2, q3, q4, agentName, adapterType, cwd, model, command, args, url,
    createdCompanyId, createdCompanyPrefix, createdAgentId,
    createdCompanyGoalId, createdProjectId, createdIssueRef,
    onboardingPath, growWorkflows, growPainPoints, growAutomate,
  ]);

  const {
    data: adapterModels,
    error: adapterModelsError,
    isLoading: adapterModelsLoading,
    isFetching: adapterModelsFetching
  } = useQuery({
    // The wizard doesn't expose an environment selector, so models always
    // resolve against the local Paperclip host (environmentId = null).
    queryKey: createdCompanyId
      ? queryKeys.agents.adapterModels(createdCompanyId, adapterType, null)
      : ["agents", "none", "adapter-models", adapterType, null],
    queryFn: () => agentsApi.adapterModels(createdCompanyId!, adapterType, { environmentId: null }),
    // Models are picked on step 4 (Connect a model).
    enabled: Boolean(createdCompanyId) && effectiveOnboardingOpen && step === 4
  });
  const getCapabilities = useAdapterCapabilities();
  const adapterCaps = getCapabilities(adapterType);
  const isLocalAdapterCaps =
    adapterCaps.supportsInstructionsBundle ||
    adapterCaps.supportsSkills ||
    adapterCaps.supportsLocalAgentJwt;
  const isLocalAdapter =
    isLocalAdapterCaps ||
    adapterType === "claude_local" ||
    adapterType === "codex_local" ||
    adapterType === "gemini_local" ||
    adapterType === "opencode_local" ||
    adapterType === "pi_local" ||
    adapterType === "cursor";
  // Build adapter grids dynamically from the UI registry + display metadata.
  // External/plugin adapters automatically appear with generic defaults, and
  // server-disabled types are filtered out.
  const { recommendedAdapters, moreAdapters } = useMemo(() => {
    const SYSTEM_ADAPTER_TYPES = new Set(["process", "http"]);
    const all = listUIAdapters()
      .filter((a) =>
        !SYSTEM_ADAPTER_TYPES.has(a.type) &&
        !disabledTypes.has(a.type) &&
        isVisualAdapterChoice(a.type)
      )
      .map((a) => ({ ...getAdapterDisplay(a.type), type: a.type }));

    return {
      recommendedAdapters: all.filter((a) => a.recommended),
      moreAdapters: all.filter((a) => !a.recommended),
    };
  }, [disabledTypes]);

  const COMMAND_PLACEHOLDERS: Record<string, string> = {
    claude_local: "claude",
    codex_local: "codex",
    gemini_local: "gemini",
    pi_local: "pi",
    cursor: "agent",
    opencode_local: "opencode",
  };
  const effectiveAdapterCommand =
    command.trim() ||
    (COMMAND_PLACEHOLDERS[adapterType] ?? adapterType.replace(/_local$/, ""));

  useEffect(() => {
    if (step !== 4) return;
    setAdapterEnvResult(null);
    setAdapterEnvError(null);
  }, [step, adapterType, model, command, args, url]);

  const selectedModel = (adapterModels ?? []).find((m) => m.id === model);
  const hasAnthropicApiKeyOverrideCheck =
    adapterEnvResult?.checks.some(
      (check) =>
        check.code === "claude_anthropic_api_key_overrides_subscription"
    ) ?? false;
  const shouldSuggestUnsetAnthropicApiKey =
    adapterType === "claude_local" &&
    adapterEnvResult?.status === "fail" &&
    hasAnthropicApiKeyOverrideCheck;
  const filteredModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    return (adapterModels ?? []).filter((entry) => {
      if (!query) return true;
      const provider = extractProviderIdWithFallback(entry.id, "");
      return (
        entry.id.toLowerCase().includes(query) ||
        entry.label.toLowerCase().includes(query) ||
        provider.toLowerCase().includes(query)
      );
    });
  }, [adapterModels, modelSearch]);
  const groupedModels = useMemo(() => {
    if (adapterType !== "opencode_local") {
      return [
        {
          provider: "models",
          entries: [...filteredModels].sort((a, b) => a.id.localeCompare(b.id))
        }
      ];
    }
    const groups = new Map<string, Array<{ id: string; label: string }>>();
    for (const entry of filteredModels) {
      const provider = extractProviderIdWithFallback(entry.id);
      const bucket = groups.get(provider) ?? [];
      bucket.push(entry);
      groups.set(provider, bucket);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, entries]) => ({
        provider,
        entries: [...entries].sort((a, b) => a.id.localeCompare(b.id))
      }));
  }, [filteredModels, adapterType]);

  function reset() {
    localStorage.removeItem(ONBOARDING_STORAGE_KEY);
    setStep(0);
    setOnboardingPath(null);
    setGrowWorkflows("");
    setGrowPainPoints("");
    setGrowAutomate("");
    setLoading(false);
    setError(null);
    setCompanyName("");
    setCompanyGoal("");
    setCompanyWebsite("");
    setCompanyImportantLinks("");
    setCompanyDocuments([]);
    setAddMarketingStack(false);
    setAgentName("CEO");
    setMissionPath(null);
    setMissionConfirmed(false);
    setQ1("");
    setQ2("");
    setQ3("");
    setQ4("");
    setAdapterType("claude_local");
    setModel("");
    setCommand("");
    setArgs("");
    setUrl("");
    setAdapterEnvResult(null);
    setAdapterEnvError(null);
    setAdapterEnvLoading(false);
    setForceUnsetAnthropicApiKey(false);
    setUnsetAnthropicLoading(false);
    setTaskTitle(DEFAULT_TASK_TITLE);
    setTaskDescription(DEFAULT_TASK_DESCRIPTION);
    setCreatedCompanyId(null);
    setCreatedCompanyPrefix(null);
    setCreatedAgentId(null);
    setCreatedCompanyGoalId(null);
    setCreatedProjectId(null);
    setCreatedIssueRef(null);
    setCreatedIssueId(null);
    setCreatedResearchIssueId(null);
  }

  function handleClose() {
    reset();
    closeOnboarding();
    // On the /onboarding route the wizard is also kept open by the route
    // itself, so closing the dialog must mark the route dismissed — otherwise
    // effectiveOnboardingOpen stays true and the wizard re-renders instead of
    // handing off to the launcher card (PAP-52).
    setRouteDismissed(true);
  }

  async function handleLaunchToDashboard() {
    if (!createdCompanyId || !createdAgentId) {
      setError(INCOMPLETE_ONBOARDING_STATE_MESSAGE);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      let goalId = createdCompanyGoalId;
      if (!goalId) {
        const goals = await goalsApi.list(createdCompanyId);
        goalId = selectDefaultCompanyGoalId(goals);
        setCreatedCompanyGoalId(goalId);
      }

      let projectId = createdProjectId;
      if (!projectId) {
        const projects = await projectsApi.list(createdCompanyId);
        const existingOnboardingProject = selectReusableOnboardingProject(projects);
        if (existingOnboardingProject) {
          projectId = existingOnboardingProject.id;
        } else {
          const project = await projectsApi.create(
            createdCompanyId,
            buildOnboardingProjectPayload(goalId)
          );
          projectId = project.id;
          queryClient.invalidateQueries({
            queryKey: queryKeys.projects.list(createdCompanyId)
          });
        }
        setCreatedProjectId(projectId);
      }

      if (!createdIssueRef) {
        const issue = await issuesApi.create(
          createdCompanyId,
          buildOnboardingIssuePayload({
            title: DEFAULT_TASK_TITLE,
            description: DEFAULT_TASK_DESCRIPTION,
            assigneeAgentId: createdAgentId,
            projectId,
            goalId
          })
        );
        setCreatedIssueRef(issue.identifier ?? issue.id);
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.list(createdCompanyId)
        });
      }

      const prefix = createdCompanyPrefix;
      setSelectedCompanyId(createdCompanyId);
      reset();
      closeOnboarding();
      navigate(prefix ? `/${prefix}/dashboard` : "/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to launch first task");
    } finally {
      setLoading(false);
    }
  }

  function buildAdapterConfig(): Record<string, unknown> {
    const adapter = getUIAdapter(adapterType);
    const config = adapter.buildAdapterConfig({
      ...defaultCreateValues,
      adapterType,
      model:
        adapterType === "gemini_local"
          ? model || DEFAULT_GEMINI_LOCAL_MODEL
          : adapterType === "cursor"
            ? model || DEFAULT_CURSOR_LOCAL_MODEL
            : adapterType === "opencode_local"
              ? model || DEFAULT_OPENCODE_LOCAL_MODEL
              : model,
      command,
      args,
      url,
      dangerouslySkipPermissions:
        adapterType === "claude_local" || adapterType === "opencode_local",
      dangerouslyBypassSandbox:
        adapterType === "codex_local"
          ? DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX
          : defaultCreateValues.dangerouslyBypassSandbox
    });
    if (adapterType === "claude_local" && forceUnsetAnthropicApiKey) {
      const env =
        typeof config.env === "object" &&
        config.env !== null &&
        !Array.isArray(config.env)
          ? { ...(config.env as Record<string, unknown>) }
          : {};
      env.ANTHROPIC_API_KEY = { type: "plain", value: "" };
      config.env = env;
    }
    return config;
  }

  async function runAdapterEnvironmentTest(
    adapterConfigOverride?: Record<string, unknown>
  ): Promise<AdapterEnvironmentTestResult | null> {
    if (!createdCompanyId) {
      setAdapterEnvError(
        "Create or select a company before testing adapter environment."
      );
      return null;
    }
    setAdapterEnvLoading(true);
    setAdapterEnvError(null);
    try {
      const result = await agentsApi.testEnvironment(
        createdCompanyId,
        adapterType,
        {
          adapterConfig: adapterConfigOverride ?? buildAdapterConfig()
        }
      );
      setAdapterEnvResult(result);
      return result;
    } catch (err) {
      setAdapterEnvError(
        err instanceof Error ? err.message : "Adapter environment test failed"
      );
      return null;
    } finally {
      setAdapterEnvLoading(false);
    }
  }

  // Step 2 → 3 ("Confirm mission"): create the company + its company-level
  // goal, then advance to naming the team lead. Guarded so revisiting the
  // mission step (e.g. via Back) doesn't create a duplicate company.
  async function handleConfirmMission() {
    if (createdCompanyId) {
      setStep(3);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const importantLinks = companyImportantLinks
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter(Boolean);
      const company = await companiesApi.create({
        name: companyName.trim(),
        website: companyWebsite.trim() || null,
        importantLinks
      });
      setCreatedCompanyId(company.id);
      setCreatedCompanyPrefix(company.issuePrefix);
      setSelectedCompanyId(company.id);
      if (addMarketingStack) {
        void startMarketingStackImport(company.id);
      }
      setTaskTitle(DEFAULT_TASK_TITLE.replaceAll("{{company_name}}", company.name));
      setTaskDescription(buildCompanyResearchTaskDescription({
        companyId: company.id,
        website: companyWebsite.trim(),
        importantLinks,
        documentNames: companyDocuments.map((file) => file.name)
      }));
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });

      const parsedGoal = parseOnboardingGoalInput(companyGoal);
      const goal = await goalsApi.create(company.id, {
        title: parsedGoal.title,
        ...(parsedGoal.description
          ? { description: parsedGoal.description }
          : {}),
        level: "company",
        status: "active"
      });
      setCreatedCompanyGoalId(goal.id);
      queryClient.invalidateQueries({
        queryKey: queryKeys.goals.list(company.id)
      });

      setStep(3); // → Create your team lead
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create company");
    } finally {
      setLoading(false);
    }
  }

  // Step 4 → 5 ("Give it a heartbeat"): hire the lead agent + seed its
  // instructions, then advance to Review. Guarded so revisiting step 4
  // doesn't hire a second agent.
  async function handleGiveHeartbeat() {
    if (!createdCompanyId) return;
    if (createdAgentId) {
      setStep(5);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      if (adapterType === "opencode_local") {
        const selectedModelId = model.trim();
        if (!isValidOpenCodeModelId(selectedModelId)) {
          setError(
            "OpenCode requires an explicit model in provider/model format."
          );
          return;
        }
        if (adapterModelsError) {
          setError(
            adapterModelsError instanceof Error
              ? adapterModelsError.message
              : "Failed to load OpenCode models."
          );
          return;
        }
        if (adapterModelsLoading || adapterModelsFetching) {
          setError(
            "OpenCode models are still loading. Please wait and try again."
          );
          return;
        }
        const discoveredModels = adapterModels ?? [];
        if (!discoveredModels.some((entry) => entry.id === selectedModelId)) {
          setError(
            discoveredModels.length === 0
              ? "No OpenCode models discovered. Run `opencode models` and authenticate providers."
              : `Configured OpenCode model is unavailable: ${selectedModelId}`
          );
          return;
        }
      }

      if (isLocalAdapter) {
        const result = adapterEnvResult ?? (await runAdapterEnvironmentTest());
        if (!result) return;
      }

      const agent = createdAgentId
        ? await agentsApi.get(createdAgentId, createdCompanyId)
        : await (async () => {
          const hire = await agentsApi.hire(createdCompanyId, {
            name: agentName.trim(),
            role: "ceo",
            adapterType,
            adapterConfig: buildAdapterConfig(),
            runtimeConfig: buildNewAgentRuntimeConfig()
          });
          if (hire.approval) {
            await approvalsApi.approve(
              hire.approval.id,
              "Approved during onboarding first-agent setup."
            );
            queryClient.invalidateQueries({
              queryKey: queryKeys.approvals.list(createdCompanyId)
            });
          }
          return hire.agent;
        })();
      setCreatedAgentId(agent.id);

      if (addMarketingStack) {
        const existingAgents = await agentsApi.list(createdCompanyId);
        const agentByName = new Map(
          existingAgents.map((entry) => [entry.name.trim().toLowerCase(), entry])
        );
        const marketingStackAgentLinks = [];
        for (const definition of MARKETING_STACK_AGENTS) {
          const nameKey = definition.name.trim().toLowerCase();
          let stackAgent = agentByName.get(nameKey);
          if (!stackAgent) {
            const stackHire = await agentsApi.hire(createdCompanyId, {
              name: definition.name,
              role: "general",
              reportsTo: agent.id,
              capabilities: definition.capabilities,
              adapterType,
              adapterConfig: buildAdapterConfig(),
              runtimeConfig: buildNewAgentRuntimeConfig(),
              instructionsBundle: {
                entryFile: "AGENTS.md",
                files: {
                  "AGENTS.md": definition.instructions
                }
              }
            });
            if (stackHire.approval) {
              await approvalsApi.approve(
                stackHire.approval.id,
                "Approved during onboarding Marketing Stack setup."
              );
            }
            stackAgent = stackHire.agent;
            agentByName.set(nameKey, stackAgent);
          }

          marketingStackAgentLinks.push({
            agentId: stackAgent.id,
            desiredSkillRefs: definition.desiredSkillRefs,
            skillSlugs: [
              ...(definition.needsTikTokSkill ? ["tiktok-app-marketing"] : []),
              ...(definition.needsProductIdeationSkills
                ? ["brainstorm-ideas", "jobs-to-be-done", "opportunity-solution-tree"]
                : []),
            ],
          });
        }
        registerMarketingStackAgents(createdCompanyId, marketingStackAgentLinks);
      }

      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(createdCompanyId)
      });

      // Seed the CEO's agent instructions file so the agent always has
      // company context + a hiring-plan output format rule. Non-fatal on
      // failure — the agent can still function with adapter defaults.
      try {
        const bundle = await agentsApi.instructionsBundle(agent.id, createdCompanyId);
        await agentsApi.saveInstructionsFile(
          agent.id,
          {
            path: bundle.entryFile,
            content: composeCeoInstructions({
              companyName,
              companyGoal,
              growPath: onboardingPath === "grow",
              growWorkflows,
              growPainPoints,
              growAutomate,
              q1, q2, q3, q4,
            }),
          },
          createdCompanyId,
        );
      } catch (err) {
        console.warn("Failed to seed CEO instructions:", err);
      }

      // Advance to the Review step — the lead is now online. The user drives
      // strategy + hiring from the planning chat after "Get started".
      setStep(5);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      setLoading(false);
    }
  }

  async function handleUnsetAnthropicApiKey() {
    if (!createdCompanyId || unsetAnthropicLoading) return;
    setUnsetAnthropicLoading(true);
    setError(null);
    setAdapterEnvError(null);
    setForceUnsetAnthropicApiKey(true);

    const configWithUnset = (() => {
      const config = buildAdapterConfig();
      const env =
        typeof config.env === "object" &&
        config.env !== null &&
        !Array.isArray(config.env)
          ? { ...(config.env as Record<string, unknown>) }
          : {};
      env.ANTHROPIC_API_KEY = { type: "plain", value: "" };
      config.env = env;
      return config;
    })();

    try {
      if (createdAgentId) {
        await agentsApi.update(
          createdAgentId,
          { adapterConfig: configWithUnset },
          createdCompanyId
        );
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.list(createdCompanyId)
        });
      }

      const result = await runAdapterEnvironmentTest(configWithUnset);
      if (result?.status === "fail") {
        setError(
          "Retried with ANTHROPIC_API_KEY unset in adapter config, but the environment test is still failing."
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to unset ANTHROPIC_API_KEY and retry."
      );
    } finally {
      setUnsetAnthropicLoading(false);
    }
  }

  async function handleStep3Next() {
    if (!createdCompanyId || !createdAgentId) return;
    setError(null);
    setStep(4);
  }

  async function handleLaunch() {
    if (!createdCompanyId || !createdAgentId) return;
    setLoading(true);
    setError(null);
    try {
      let goalId = createdCompanyGoalId;
      if (!goalId) {
        const goals = await goalsApi.list(createdCompanyId);
        goalId = selectDefaultCompanyGoalId(goals);
        setCreatedCompanyGoalId(goalId);
      }

      let projectId = createdProjectId;
      if (!projectId) {
        const project = await projectsApi.create(
          createdCompanyId,
          buildOnboardingProjectPayload(goalId)
        );
        projectId = project.id;
        setCreatedProjectId(projectId);
        queryClient.invalidateQueries({
          queryKey: queryKeys.projects.list(createdCompanyId)
        });
      }

      let issueRef = createdIssueRef;
      let issueId = createdIssueId;
      if (!issueRef || !issueId) {
        const issue = await issuesApi.create(
          createdCompanyId,
          {
            ...buildOnboardingIssuePayload({
            title: taskTitle,
            description: taskDescription,
            assigneeAgentId: createdAgentId,
            projectId,
            goalId
            }),
            priority: "high"
          }
        );
        issueId = issue.id;
        issueRef = issue.identifier ?? issue.id;
        setCreatedIssueId(issue.id);
        setCreatedIssueRef(issueRef);
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.list(createdCompanyId)
        });
      }

      if (createdResearchIssueId !== issueId) {
        for (const file of companyDocuments) {
          await issuesApi.uploadAttachment(createdCompanyId, issueId, file);
        }

        await agentsApi.wakeup(createdAgentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "Company onboarding research sources are ready for vector-memory ingestion.",
          payload: {
            issueId,
            companyId: createdCompanyId,
            vectorMemoryUserId: createdCompanyId
          },
          idempotencyKey: `company-onboarding-research:${createdCompanyId}`
        }, createdCompanyId);
        setCreatedResearchIssueId(issueId);
      }

      if (addMarketingStack) {
        const [companyAgents, existingRoutines] = await Promise.all([
          agentsApi.list(createdCompanyId),
          routinesApi.list(createdCompanyId),
        ]);
        const agentByName = new Map(
          companyAgents.map((entry) => [entry.name.trim().toLowerCase(), entry])
        );
        const existingRoutineTitles = new Set(
          existingRoutines.map((entry) => entry.title.trim().toLowerCase())
        );
        const companyRecord = companies.find((entry) => entry.id === createdCompanyId);
        const onboardingImportantLinks = companyImportantLinks
          .split(/\r?\n/)
          .map((entry) => entry.trim())
          .filter(Boolean);
        const companyContext = {
          companyId: createdCompanyId,
          companyName: companyRecord?.name ?? companyName.trim(),
          website: companyRecord?.website ?? companyWebsite.trim(),
          importantLinks: companyRecord?.importantLinks ?? onboardingImportantLinks,
          documentNames: companyDocuments.map((file) => file.name),
        };

        for (const routineDefinition of MARKETING_STACK_ROUTINES) {
          const materializedContent = "materializeForCompany" in routineDefinition && routineDefinition.materializeForCompany
            ? buildMarketingInnovationWorkflowContent(companyContext)
            : null;
          const routineTitle = materializedContent?.title ?? routineDefinition.title;
          const routineDescription = materializedContent?.description ?? routineDefinition.description;
          if (
            existingRoutineTitles.has(routineTitle.toLowerCase())
            || existingRoutineTitles.has(routineDefinition.title.toLowerCase())
          ) {
            continue;
          }
          const assignee = agentByName.get(
            routineDefinition.assigneeName.toLowerCase()
          );
          if (!assignee) continue;

          const routine = await routinesApi.create(createdCompanyId, {
            title: routineTitle,
            description: routineDescription,
            assigneeAgentId: assignee.id,
            projectId,
            goalId,
            priority: "high",
            status: "active",
            concurrencyPolicy: "coalesce_if_active",
            catchUpPolicy: "skip_missed",
          });
          const trigger = "trigger" in routineDefinition && routineDefinition.trigger
            ? routineDefinition.trigger
            : { kind: "api" as const, label: "Manual run", enabled: true };
          await routinesApi.createTrigger(routine.id, trigger);
          existingRoutineTitles.add(routineTitle.toLowerCase());
        }

        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.list(createdCompanyId, { projectId }),
        });
      }

      setSelectedCompanyId(createdCompanyId);
      reset();
      closeOnboarding();
      navigate(
        createdCompanyPrefix
          ? `/${createdCompanyPrefix}/issues/${issueRef}`
          : `/issues/${issueRef}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create task");
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (step === 0) return; // front door requires click
      if (step === 1 && companyName.trim()) setStep(2);
      else if (step === 2 && companyName.trim() && companyGoal.trim()) handleConfirmMission();
      else if (step === 3 && agentName.trim()) setStep(4);
      else if (step === 4 && agentName.trim()) handleGiveHeartbeat();
      else if (step === 5) handleLaunchToDashboard();
    }
  }

  if (!effectiveOnboardingOpen) return null;

  const launchStateIncomplete = step === 5 && (!createdCompanyId || !createdAgentId);
  const visibleError = error ?? (launchStateIncomplete ? INCOMPLETE_ONBOARDING_STATE_MESSAGE : null);

  return (
    <Dialog
      open={effectiveOnboardingOpen}
      onOpenChange={(open) => {
        if (!open) {
          handleClose();
        }
      }}
    >
      <DialogPortal>
        {/* Plain div instead of DialogOverlay — Radix's overlay wraps in
            RemoveScroll which blocks wheel events on our custom (non-DialogContent)
            scroll container. A plain div preserves the background without scroll-locking. */}
        <div className="fixed inset-0 z-50 bg-background" />
        <div className="fixed inset-0 z-50 flex" onKeyDown={handleKeyDown}>
          {/* Close button */}
          <button
            onClick={handleClose}
            className="absolute top-4 left-4 z-10 rounded-sm p-1.5 text-muted-foreground/60 hover:text-foreground transition-colors"
          >
            <X className="h-5 w-5" />
            <span className="sr-only">Close</span>
          </button>

          {/* Step 0: Front Door — full-screen choice */}
          {step === 0 && (
            <div className="w-full flex flex-col overflow-y-auto">
              <FrontDoor onChoose={(path) => {
                setOnboardingPath(path);
                setStep(1);
              }} />
            </div>
          )}

          {/* Left half — form (steps 1+) */}
          {step !== 0 && (
          <div
            className={cn(
              "w-full flex flex-col overflow-y-auto transition-(--tp-width) duration-500 ease-in-out",
              step === 1 || step === 2 ? "md:w-1/2" : "md:w-full"
            )}
          >
            <div className="w-full max-w-md mx-auto my-auto px-8 py-12 shrink-0">
              {/* 5-segment progress bar (brand .wsteps/.wstep) — segment N
                  filled once step ≥ N. Completed segments jump back. */}
              <div className="flex items-center gap-1.5 mb-8">
                {([1, 2, 3, 4, 5] as const).map((s) => {
                  const filled = step >= s;
                  const canJump = s < step;
                  return (
                    <button
                      key={s}
                      type="button"
                      aria-label={`Step ${s}`}
                      aria-current={s === step ? "step" : undefined}
                      disabled={!canJump}
                      onClick={() => canJump && setStep(s as Step)}
                      className={cn(
                        "h-1 flex-1 rounded-full transition-colors",
                        filled ? "bg-foreground" : "bg-muted",
                        canJump ? "cursor-pointer" : "cursor-default"
                      )}
                    />
                  );
                })}
              </div>

              {/* Persistent evolving capsule (steps 3–5): a single AgentCapsule
                  held in the same tree slot so React reuses the DOM node and the
                  morph reads as one capsule coming to life — dashed slot →
                  solid (configured) → liquid fill + blue glow (online). */}
              {step >= 3 && step <= 5 && (
                <div className="space-y-4 mb-6">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      {step === 5 ? (
                        <Check className="h-5 w-5 text-muted-foreground" />
                      ) : (
                        <Bot className="h-5 w-5 text-muted-foreground" />
                      )}
                    </div>
                    <div>
                      <h3 className="font-medium">
                        {step === 3
                          ? "Create your team lead"
                          : step === 4
                            ? "Connect a model"
                            : "Review"}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        {step === 3 ? (
                          <>
                            Name your lead. They'll help drive{" "}
                            <span className="font-medium text-foreground">{companyName}</span>{" "}
                            toward its mission. We default to{" "}
                            <span className="font-medium text-foreground">Chief of staff</span> —
                            rename it to anything you like.
                          </>
                        ) : step === 4 ? (
                          <>Pick the adapter and model your lead will run on, then check the environment.</>
                        ) : (
                          <>Everything's set up — your team lead is online and ready to work.</>
                        )}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-col items-center gap-1.5 py-1 text-center">
                    <AgentCapsule
                      state={step === 3 ? "slot" : step === 4 ? "configured" : "online"}
                      gradient={5}
                      glow="blue"
                      size="md"
                    />
                    <p className="text-(length:--text-micro) text-muted-foreground">
                      {step === 3 ? (
                        "an empty slot for an agent"
                      ) : step === 4 ? (
                        "your team lead, taking shape"
                      ) : (
                        <>
                          <span className="font-medium text-foreground">{agentName}</span>{" "}
                          is online and ready to work!
                        </>
                      )}
                    </p>
                  </div>
                </div>
              )}

              {/* Step content */}
              {step === 2 && onboardingPath === "grow" && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Sparkles className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Tell us about your team</h3>
                      <p className="text-xs text-muted-foreground">
                        We'll use this to set up your lead agent and plan which agents to add.
                      </p>
                    </div>
                  </div>
                  <div className="group">
                    <label className="text-xs text-muted-foreground mb-1 block">What does your team work on?</label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder="e.g. We create educational YouTube content about AI"
                      value={q1}
                      onChange={(e) => setQ1(e.target.value)}
                    />
                  </div>
                  <div className="group">
                    <label className="text-xs text-muted-foreground mb-1 block">What are your current workflows?</label>
                    <textarea
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-(--sz-60px)"
                      placeholder="e.g. Manual content creation, spreadsheet tracking, email outreach"
                      value={growWorkflows}
                      onChange={(e) => setGrowWorkflows(e.target.value)}
                    />
                  </div>
                  <div className="group">
                    <label className="text-xs text-muted-foreground mb-1 block">What pain points would you solve with AI?</label>
                    <textarea
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-(--sz-60px)"
                      placeholder="e.g. Can't produce content fast enough, no time for social media"
                      value={growPainPoints}
                      onChange={(e) => setGrowPainPoints(e.target.value)}
                    />
                  </div>
                  <div className="group">
                    <label className="text-xs text-muted-foreground mb-1 block">What would you automate first?</label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder="e.g. Social media scheduling and content repurposing"
                      value={growAutomate}
                      onChange={(e) => setGrowAutomate(e.target.value)}
                    />
                  </div>
                  {companyName.trim() && q1.trim() && (
                    <>
                      {!companyGoal.trim() && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            const parts = [q1.trim()];
                            if (growPainPoints.trim()) parts.push(`Key challenge: ${growPainPoints.trim()}`);
                            if (growAutomate.trim()) parts.push(`First priority: automate ${growAutomate.trim().toLowerCase()}`);
                            setCompanyGoal(parts.join(". "));
                          }}
                        >
                          Generate mission from answers
                        </Button>
                      )}
                      {companyGoal.trim() && (
                        <div className="group">
                          <label className="text-xs text-foreground mb-1 block">Generated mission — edit however you like:</label>
                          <textarea
                            className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-(--sz-60px)"
                            value={companyGoal}
                            onChange={(e) => setCompanyGoal(e.target.value)}
                          />
                        </div>
                      )}
                    </>
                  )}
                  <button
                    className="text-(length:--text-micro) text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => { setOnboardingPath(null); setStep(0); }}
                  >
                    ← Back to start
                  </button>
                </div>
              )}

              {/* Step 1: Name your company (both paths) */}
              {step === 1 && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Building2 className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Name your company</h3>
                      <p className="text-xs text-muted-foreground">
                        What should we call your company?
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 group">
                    <label
                      className={cn(
                        "text-xs mb-1 block transition-colors",
                        companyName.trim()
                          ? "text-foreground"
                          : "text-muted-foreground group-focus-within:text-foreground"
                      )}
                    >
                      Company name
                    </label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder="Acme Corp"
                      value={companyName}
                      onChange={(e) => setCompanyName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && companyName.trim()) {
                          e.preventDefault();
                          if (onboardingPath !== "grow" && !missionPath) setMissionPath("direct");
                          setStep(2);
                        }
                      }}
                      autoFocus
                    />
                  </div>
                  <button
                    className="text-(length:--text-micro) text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => { setOnboardingPath(null); setStep(0); }}
                  >
                    ← Back to start
                  </button>
                </div>
              )}

              {/* Step 2: Define your mission */}
              {step === 2 && onboardingPath !== "grow" && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Building2 className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Define your mission</h3>
                      <p className="text-xs text-muted-foreground">
                        Your mission guides everything — your lead agent, who you bring on, and the work <strong>{companyName}</strong> takes on.
                      </p>
                    </div>
                  </div>

                  {/* Mission path selector */}
                  <div className="space-y-3">
                    <label className="text-xs text-foreground block">
                      How would you like to define your mission?
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        className={cn(
                          "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors",
                          missionPath === "direct"
                            ? "border-foreground bg-accent/50"
                            : "border-border hover:bg-accent/50"
                        )}
                        onClick={() => setMissionPath("direct")}
                      >
                        <Sparkles className="h-4 w-4" />
                        <span className="font-medium">I know my mission</span>
                        <span className="text-muted-foreground text-(length:--text-nano)">
                          Type it directly
                        </span>
                      </button>
                      <button
                        className={cn(
                          "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors",
                          missionPath === "questionnaire"
                            ? "border-foreground bg-accent/50"
                            : "border-border hover:bg-accent/50"
                        )}
                        onClick={() => setMissionPath("questionnaire")}
                      >
                        <ListTodo className="h-4 w-4" />
                        <span className="font-medium">Help me figure it out</span>
                        <span className="text-muted-foreground text-(length:--text-nano)">
                          Answer a few questions
                        </span>
                      </button>
                    </div>
                  </div>

                  {/* Direct mission input */}
                  {missionPath === "direct" && (
                    <div className="space-y-3 animate-in fade-in duration-200">
                      <div className="group">
                        <label
                          className={cn(
                            "text-xs mb-1 block transition-colors",
                            companyGoal.trim()
                              ? "text-foreground"
                              : "text-muted-foreground group-focus-within:text-foreground"
                          )}
                        >
                          Mission
                        </label>
                        <textarea
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-(--sz-60px)"
                          placeholder="What is your team trying to achieve?"
                          value={companyGoal}
                          onChange={(e) => setCompanyGoal(e.target.value)}
                          autoFocus
                        />
                      </div>
                      {/* Prompt chips for inspiration */}
                      <div className="flex flex-wrap gap-1.5">
                        {MISSION_PROMPT_CHIPS.map((chip) => (
                          <button
                            key={chip}
                            className={cn(
                              "rounded-full border px-2.5 py-1 text-(length:--text-micro) transition-colors",
                              companyGoal === chip
                                ? "border-foreground bg-accent text-foreground"
                                : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/50"
                            )}
                            onClick={() => setCompanyGoal(chip)}
                          >
                            {chip}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Questionnaire path */}
                  {missionPath === "questionnaire" && !missionConfirmed && (
                    <div className="space-y-3 animate-in fade-in duration-200">
                      <div className="group">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          What does your team work on?
                        </label>
                        <input
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                          placeholder="e.g. We create educational YouTube content about AI"
                          value={q1}
                          onChange={(e) => setQ1(e.target.value)}
                          autoFocus
                        />
                      </div>
                      <div className="group">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          Who do you serve?
                        </label>
                        <input
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                          placeholder="e.g. Non-technical professionals curious about AI tools"
                          value={q2}
                          onChange={(e) => setQ2(e.target.value)}
                        />
                      </div>
                      <div className="group">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          What's your biggest bottleneck right now?
                        </label>
                        <input
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                          placeholder="e.g. Can't produce content fast enough across multiple channels"
                          value={q3}
                          onChange={(e) => setQ3(e.target.value)}
                        />
                      </div>
                      <div className="group">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          What would success look like in 6 months?
                        </label>
                        <input
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                          placeholder="e.g. Publishing daily content across 4 platforms with a team of AI agents"
                          value={q4}
                          onChange={(e) => setQ4(e.target.value)}
                        />
                      </div>
                      {q1.trim() && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setCompanyGoal(buildMissionFromQuestionnaire(q1, q2, q3, q4));
                            setMissionConfirmed(true);
                          }}
                        >
                          Generate my mission
                        </Button>
                      )}
                    </div>
                  )}

                  {/* Questionnaire result — editable mission */}
                  {missionPath === "questionnaire" && missionConfirmed && (
                    <div className="space-y-3 animate-in fade-in duration-200">
                      <div className="group">
                        <label className="text-xs text-foreground mb-1 block">
                          Here's your draft mission — edit it however you like:
                        </label>
                        <textarea
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-(--sz-80px)"
                          value={companyGoal}
                          onChange={(e) => setCompanyGoal(e.target.value)}
                          autoFocus
                        />
                      </div>
                      <button
                        className="text-(length:--text-micro) text-muted-foreground hover:text-foreground transition-colors"
                        onClick={() => { setMissionConfirmed(false); setCompanyGoal(""); }}
                      >
                        ← Back to questions
                      </button>
                    </div>
                  )}

                  {/* Confirm mission note */}
                  {companyGoal.trim() && (
                    <p className="text-(length:--text-micro) text-muted-foreground italic">
                      You can always change your mission later in settings.
                    </p>
                  )}

                  <button
                    className="text-(length:--text-micro) text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => setStep(1)}
                  >
                    ← Change company name
                  </button>
                </div>
              )}

              {/* Step 3: Create your team lead — name only (capsule above) */}
              {step === 3 && (
                <div className="space-y-5">
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Name
                    </label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder="Chief of staff"
                      value={agentName}
                      onChange={(e) => setAgentName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && agentName.trim()) {
                          e.preventDefault();
                          setStep(4);
                        }
                      }}
                      autoFocus
                    />
                  </div>
                  <div className="group">
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Website (optional)
                    </label>
                    <input
                      type="url"
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder="https://acme.com"
                      value={companyWebsite}
                      onChange={(e) => setCompanyWebsite(e.target.value)}
                    />
                  </div>
                  <div className="group">
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Important links (optional, one per line)
                    </label>
                    <textarea
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-[72px]"
                      placeholder={"https://docs.acme.com\nhttps://linkedin.com/company/acme"}
                      value={companyImportantLinks}
                      onChange={(e) => setCompanyImportantLinks(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Company documents (optional)
                    </label>
                    <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground">
                      <Upload className="h-4 w-4" />
                      Upload documents
                      <input
                        type="file"
                        multiple
                        className="hidden"
                        accept=".pdf,.doc,.docx,.txt,.md,.csv,.ppt,.pptx,.xls,.xlsx,application/pdf,text/*"
                        onChange={(event) => {
                          const files = Array.from(event.target.files ?? []);
                          setCompanyDocuments((current) => [...current, ...files]);
                          event.target.value = "";
                        }}
                      />
                    </label>
                    {companyDocuments.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {companyDocuments.map((file, index) => (
                          <div key={`${file.name}-${file.size}-${index}`} className="flex items-center justify-between gap-2 text-xs">
                            <span className="truncate text-muted-foreground">{file.name}</span>
                            <button
                              type="button"
                              className="text-muted-foreground hover:text-foreground"
                              onClick={() => setCompanyDocuments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 hover:bg-accent/40">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4"
                      checked={addMarketingStack}
                      onChange={(event) => setAddMarketingStack(event.target.checked)}
                    />
                    <span>
                      <span className="block text-sm font-medium">
                        Add Marketing Stack
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        Adds Market Research, Market Intelligence, and Carousel
                        Social Media agents. All three report directly to the CEO.
                      </span>
                    </span>
                  </label>
                </div>
              )}

              {/* Step 4: Connect a model — adapter + model + env check (capsule above) */}
              {step === 4 && (
                <div className="space-y-5">
                  {/* Adapter type radio cards */}
                  <div>
                    <label className="text-xs text-muted-foreground mb-2 block">
                      Adapter type
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      {recommendedAdapters.map((opt) => (
                        <button
                          key={opt.type}
                          className={cn(
                            "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors relative",
                            adapterType === opt.type
                              ? "border-foreground bg-accent"
                              : "border-border hover:bg-accent/50"
                          )}
                          onClick={() => {
                            const nextType = opt.type;
                            setAdapterType(nextType);
                            if (nextType === "codex_local") {
                              return;
                            }
                            if (nextType === "opencode_local") {
                              setModel(DEFAULT_OPENCODE_LOCAL_MODEL);
                              return;
                            }
                            setModel("");
                          }}
                        >
                          {opt.recommended && (
                            <Badge variant="ghost" className="absolute -top-1.5 right-1.5 bg-green-500 text-white text-(length:--text-nano) font-semibold px-1.5 leading-none">
                              Recommended
                            </Badge>
                          )}
                          <opt.icon className="h-4 w-4" />
                          <span className="font-medium">{opt.label}</span>
                          <span className="text-muted-foreground text-(length:--text-nano)">
                            {opt.description}
                          </span>
                        </button>
                      ))}
                    </div>

                    <button
                      className="flex items-center gap-1.5 mt-3 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => setShowMoreAdapters((v) => !v)}
                    >
                      <ChevronDown
                        className={cn(
                          "h-3 w-3 transition-transform",
                          showMoreAdapters ? "rotate-0" : "-rotate-90"
                        )}
                      />
                      More Agent Adapter Types
                    </button>

                    {showMoreAdapters && (
                      <div className="grid grid-cols-2 gap-2 mt-2">
                        {moreAdapters.map((opt) => (
                           <button
                             key={opt.type}
                             disabled={!!opt.comingSoon}
                             className={cn(
                               "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors relative",
                               opt.comingSoon
                                 ? "border-border opacity-40 cursor-not-allowed"
                                 : adapterType === opt.type
                                 ? "border-foreground bg-accent"
                                 : "border-border hover:bg-accent/50"
                             )}
                             onClick={() => {
                               if (opt.comingSoon) return;
                               const nextType = opt.type;
                              setAdapterType(nextType);
                              if (nextType === "gemini_local" && !model) {
                                setModel(DEFAULT_GEMINI_LOCAL_MODEL);
                                return;
                              }
                              if (nextType === "cursor" && !model) {
                                setModel(DEFAULT_CURSOR_LOCAL_MODEL);
                                return;
                              }
                              if (nextType === "opencode_local") {
                                setModel(DEFAULT_OPENCODE_LOCAL_MODEL);
                                return;
                              }
                              setModel("");
                            }}
                          >
                            <opt.icon className="h-4 w-4" />
                            <span className="font-medium">{opt.label}</span>
                            <span className="text-muted-foreground text-(length:--text-nano)">
                              {opt.comingSoon
                                ? opt.disabledLabel ?? "Coming soon"
                                : opt.description}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Conditional adapter fields */}
                  {isLocalAdapter && (
                    <div className="space-y-3">
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">
                          Model
                        </label>
                        <Popover
                          open={modelOpen}
                          onOpenChange={(next) => {
                            setModelOpen(next);
                            if (!next) setModelSearch("");
                          }}
                        >
                          <PopoverTrigger asChild>
                            <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
                              <span
                                className={cn(
                                  !model && "text-muted-foreground"
                                )}
                              >
                                {selectedModel
                                  ? selectedModel.label
                                  : model ||
                                    (adapterType === "opencode_local"
                                      ? "Select model (required)"
                                      : "Default")}
                              </span>
                              <ChevronDown className="h-3 w-3 text-muted-foreground" />
                            </button>
                          </PopoverTrigger>
                          <PopoverContent
                            className="w-(--radix-popover-trigger-width) p-1"
                            align="start"
                          >
                            <input
                              className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
                              placeholder="Search models..."
                              value={modelSearch}
                              onChange={(e) => setModelSearch(e.target.value)}
                              autoFocus
                            />
                            {adapterType !== "opencode_local" && (
                              <button
                                className={cn(
                                  "flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                                  !model && "bg-accent"
                                )}
                                onClick={() => {
                                  setModel("");
                                  setModelOpen(false);
                                }}
                              >
                                Default
                              </button>
                            )}
                            <div className="max-h-(--sz-240px) overflow-y-auto">
                              {groupedModels.map((group) => (
                                <div
                                  key={group.provider}
                                  className="mb-1 last:mb-0"
                                >
                                  {adapterType === "opencode_local" && (
                                    <div className="px-2 py-1 text-(length:--text-nano) uppercase tracking-wide text-muted-foreground">
                                      {group.provider} ({group.entries.length})
                                    </div>
                                  )}
                                  {group.entries.map((m) => (
                                    <button
                                      key={m.id}
                                      className={cn(
                                        "flex items-center w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                                        m.id === model && "bg-accent"
                                      )}
                                      onClick={() => {
                                        setModel(m.id);
                                        setModelOpen(false);
                                      }}
                                    >
                                      <span
                                        className="block w-full text-left truncate"
                                        title={m.id}
                                      >
                                        {adapterType === "opencode_local"
                                          ? extractModelName(m.id)
                                          : m.label}
                                      </span>
                                    </button>
                                  ))}
                                </div>
                              ))}
                            </div>
                            {filteredModels.length === 0 && (
                              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                                No models discovered.
                              </p>
                            )}
                          </PopoverContent>
                        </Popover>
                      </div>
                    </div>
                  )}

                  {isLocalAdapter && (
                    <div className="space-y-2 rounded-md border border-border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <p className="text-xs font-medium">
                            Adapter environment check
                          </p>
                          <p className="text-(length:--text-micro) text-muted-foreground">
                            Runs a live probe that asks the adapter CLI to
                            respond with hello.
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2.5 text-xs"
                          disabled={adapterEnvLoading}
                          onClick={() => void runAdapterEnvironmentTest()}
                        >
                          {adapterEnvLoading ? "Testing..." : "Test now"}
                        </Button>
                      </div>

                      {adapterEnvError && (
                        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-(length:--text-micro) text-destructive">
                          {adapterEnvError}
                        </div>
                      )}

                      {adapterEnvResult &&
                      adapterEnvResult.status === "pass" ? (
                        <div className="flex items-center gap-2 rounded-md border border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10 px-3 py-2 text-xs text-green-700 dark:text-green-300 animate-in fade-in slide-in-from-bottom-1 duration-300">
                          <Check className="h-3.5 w-3.5 shrink-0" />
                          <span className="font-medium">Passed</span>
                        </div>
                      ) : adapterEnvResult ? (
                        <AdapterEnvironmentResult result={adapterEnvResult} />
                      ) : null}

                      {shouldSuggestUnsetAnthropicApiKey && (
                        <div className="rounded-md border border-amber-300/60 bg-amber-50/40 px-2.5 py-2 space-y-2">
                          <p className="text-(length:--text-micro) text-amber-900/90 leading-relaxed">
                            Claude failed while{" "}
                            <span className="font-mono">ANTHROPIC_API_KEY</span>{" "}
                            is set. You can clear it in this adapter config
                            and retry the probe.
                          </p>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2.5 text-xs"
                            disabled={
                              adapterEnvLoading || unsetAnthropicLoading
                            }
                            onClick={() => void handleUnsetAnthropicApiKey()}
                          >
                            {unsetAnthropicLoading
                              ? "Retrying..."
                              : "Unset ANTHROPIC_API_KEY"}
                          </Button>
                        </div>
                      )}

                      {adapterEnvResult && adapterEnvResult.status === "fail" && (
                        <div className="rounded-md border border-border/70 bg-muted/20 px-2.5 py-2 text-(length:--text-micro) space-y-1.5">
                          <p className="font-medium">Manual debug</p>
                          <p className="text-muted-foreground font-mono break-all">
                            {adapterType === "cursor"
                              ? `${effectiveAdapterCommand} -p --mode ask --output-format json \"Respond with hello.\"`
                              : adapterType === "codex_local"
                              ? `${effectiveAdapterCommand} exec --json -`
                              : adapterType === "gemini_local"
                                ? `${effectiveAdapterCommand} --output-format json "Respond with hello."`
                              : adapterType === "opencode_local"
                                ? `${effectiveAdapterCommand} run --format json "Respond with hello."`
                              : `${effectiveAdapterCommand} --print - --output-format stream-json --verbose`}
                          </p>
                          <p className="text-muted-foreground">
                            Prompt:{" "}
                            <span className="font-mono">Respond with hello.</span>
                          </p>
                          {adapterType === "cursor" ||
                          adapterType === "codex_local" ||
                          adapterType === "gemini_local" ||
                          adapterType === "opencode_local" ? (
                            <p className="text-muted-foreground">
                              If auth fails, set{" "}
                              <span className="font-mono">
                                {adapterType === "cursor"
                                  ? "CURSOR_API_KEY"
                                  : adapterType === "gemini_local"
                                    ? "GEMINI_API_KEY"
                                    : "OPENAI_API_KEY"}
                              </span>{" "}
                              in env or run{" "}
                              <span className="font-mono">
                                {adapterType === "cursor"
                                  ? "agent login"
                                  : adapterType === "codex_local"
                                    ? "codex login"
                                    : adapterType === "gemini_local"
                                      ? "gemini auth"
                                      : "opencode auth login"}
                              </span>
                              .
                            </p>
                          ) : (
                            <p className="text-muted-foreground">
                              If login is required, run{" "}
                              <span className="font-mono">claude login</span>{" "}
                              and retry.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {(adapterType === "http" ||
                    adapterType === "openclaw_gateway") && (
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">
                        {adapterType === "openclaw_gateway"
                          ? "Gateway URL"
                          : "Webhook URL"}
                      </label>
                      <input
                        className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                        placeholder={
                          adapterType === "openclaw_gateway"
                            ? "ws://127.0.0.1:18789"
                            : "https://..."
                        }
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Step 5: Review — lead is online (shared capsule above) */}
              {step === 5 && (
                <div className="space-y-5 py-1">
                  {/* Review checklist — everything that's now set up */}
                  <div className="space-y-1.5">
                    {[
                      { label: "Company name", done: Boolean(companyName.trim()) },
                      { label: "Mission", done: Boolean(companyGoal.trim()) },
                      { label: "Agent created", done: Boolean(createdAgentId) },
                      { label: "Model connected", done: Boolean(createdAgentId) },
                    ].map(({ label, done }) => (
                      <div key={label} className="flex items-center gap-2 text-sm">
                        <span
                          className={cn(
                            "flex h-4 w-4 items-center justify-center rounded-full shrink-0",
                            done
                              ? "bg-green-500/15 text-green-600 dark:text-green-400"
                              : "bg-muted text-muted-foreground"
                          )}
                        >
                          <Check className="h-2.5 w-2.5" />
                        </span>
                        <span className={done ? "text-foreground" : "text-muted-foreground"}>
                          {label}
                        </span>
                      </div>
                    ))}
                  </div>

                </div>
              )}

              {/* Error */}
              {visibleError && (
                <div className="mt-3">
                  <p className="text-xs text-destructive">{visibleError}</p>
                </div>
              )}

              {/* Footer navigation */}
              <div className="flex items-center justify-between mt-8">
                <div>
                  {step > 1 && step > (effectiveOnboardingOptions.initialStep ?? 0) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setStep((step - 1) as Step)}
                      disabled={loading}
                    >
                      <ArrowLeft className="h-3.5 w-3.5 mr-1" />
                      Back
                    </Button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {step === 1 && (
                    <Button
                      size="sm"
                      disabled={!companyName.trim()}
                      onClick={() => {
                        if (onboardingPath !== "grow" && !missionPath) setMissionPath("direct");
                        setStep(2);
                      }}
                    >
                      Next
                      <ArrowRight className="h-3.5 w-3.5 ml-1" />
                    </Button>
                  )}
                  {step === 2 && (
                    <Button
                      size="sm"
                      disabled={!companyName.trim() || !companyGoal.trim() || loading}
                      onClick={handleConfirmMission}
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Creating..." : "Confirm mission"}
                    </Button>
                  )}
                  {step === 3 && (
                    <Button
                      size="sm"
                      disabled={!agentName.trim()}
                      onClick={() => setStep(4)}
                    >
                      Next
                      <ArrowRight className="h-3.5 w-3.5 ml-1" />
                    </Button>
                  )}
                  {step === 4 && (
                    <Button
                      size="sm"
                      disabled={!agentName.trim() || loading || adapterEnvLoading}
                      onClick={handleGiveHeartbeat}
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Bringing to life..." : "Give it a heartbeat"}
                    </Button>
                  )}
                  {step === 5 && (
                    <Button
                      size="sm"
                      onClick={handleLaunchToDashboard}
                      disabled={loading || launchStateIncomplete}
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Launching..." : "Get started"}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
          )}

          {/* Right half — ASCII art (hidden on mobile, only for the team
              name + mission steps) */}
          <div
            className={cn(
              "hidden md:block overflow-hidden bg-(--hex-1d1d1d) transition-(--tp-width-opacity) duration-500 ease-in-out",
              step === 1 || step === 2 ? "w-1/2 opacity-100" : "w-0 opacity-0"
            )}
          >
            <AsciiArtAnimation />
          </div>
        </div>
      </DialogPortal>
    </Dialog>
  );
}

function AdapterEnvironmentResult({
  result
}: {
  result: AdapterEnvironmentTestResult;
}) {
  const statusLabel =
    result.status === "pass"
      ? "Passed"
      : result.status === "warn"
      ? "Warnings"
      : "Failed";
  const statusClass =
    result.status === "pass"
      ? "text-green-700 dark:text-green-300 border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10"
      : result.status === "warn"
      ? "text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10"
      : "text-red-700 dark:text-red-300 border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10";

  return (
    <div className={`rounded-md border px-2.5 py-2 text-(length:--text-micro) ${statusClass}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{statusLabel}</span>
        <span className="opacity-80">
          {new Date(result.testedAt).toLocaleTimeString()}
        </span>
      </div>
      <div className="mt-1.5 space-y-1">
        {result.checks.map((check, idx) => (
          <div
            key={`${check.code}-${idx}`}
            className="leading-relaxed break-words"
          >
            <span className="font-medium uppercase tracking-wide opacity-80">
              {check.level}
            </span>
            <span className="mx-1 opacity-60">·</span>
            <span>{check.message}</span>
            {check.detail && (
              <span className="block opacity-75 break-all">
                ({check.detail})
              </span>
            )}
            {check.hint && (
              <span className="block opacity-90 break-words">
                Hint: {check.hint}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
