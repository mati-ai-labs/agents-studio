import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, guardrailPolicies, heartbeatRuns, issueApprovals, issues } from "@paperclipai/db";
import { guardrailService, redactWithMatchers } from "./guardrails.js";
import { resolveClaudeProviderEnv } from "./provider-quota-gate.js";
import { hashToolValue } from "./tool-content-guards.js";
import { logger } from "../middleware/logger.js";

/**
 * Action review: the agent-side guardrail.
 *
 * Every Claude Code agent runs with a PreToolUse hook that sends each action
 * it is about to take (tool name + input) here before the action runs, the
 * same way Claude Code's auto-mode classifier reviews commands. The review:
 *
 * 1. skips read-only actions (reading files, searching, GET requests),
 * 2. applies deterministic `action`-stage policies (restricted_action /
 *    regex on the tool and its input, e.g. block `gh pr merge`),
 * 3. asks a classifier model whether the action breaks any of the company's
 *    plain-English `rule` policies.
 *
 * The answer is allow, deny (with a reason the agent reads and re-plans
 * around), or approval (parked for the board; the agent is told to stop and
 * wait, and the exact same action is allowed once after approval).
 *
 * The same rules are injected into the agent's context at session start
 * (agentRules), so the agent plans within them rather than only being
 * corrected at each step.
 */

export type ActionReviewDecision = "allow" | "deny" | "approval";

export interface ActionReviewResult {
  decision: ActionReviewDecision;
  reason: string | null;
  policyName?: string | null;
  approvalId?: string | null;
  source?: "read_only" | "no_rules" | "policy" | "classifier" | "approved" | "error";
}

export interface AgentRule {
  id: string;
  name: string;
  rule: string;
  action: string;
}

const READ_ONLY_TOOLS = new Set([
  "Read", "Glob", "Grep", "LS", "NotebookRead", "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet",
  "TaskOutput", "ToolSearch", "WebSearch", "WebFetch", "ListMcpResourcesTool", "ReadMcpResourceTool", "BashOutput",
]);

const READ_ONLY_BASH = /^\s*(ls|cat|head|tail|less|grep|rg|find|pwd|wc|which|echo|printf|stat|file|du|df|date|env|jq|sed -n|awk|sort|uniq|cut|tr|basename|dirname|realpath|git (status|log|diff|show|branch|remote|rev-parse|fetch|ls-files|blame)|gh (pr|issue|run) (view|list|diff|checks)|psql .*-c ["']?select)\b/i;
const MUTATING_BASH_MARKERS = /(^|[^<])>(?!&)|\brm\b|\bmv\b|\bcp\b|\bchmod\b|\bchown\b|\bkill\b|\bsudo\b|\bxargs\b|\btee\b|\|\s*(sh|bash|zsh|node|python)|\b(curl|wget)\b[^|]*(\s-X\s*(POST|PUT|PATCH|DELETE)|\s--request\s*(POST|PUT|PATCH|DELETE)|\s(-d|--data|--data-raw|--data-binary|-F|--form)\b)|\bgit\s+(push|commit|merge|rebase|reset|checkout|tag)\b|\bgh\s+(pr\s+(merge|create|close|edit)|release|repo|api)\b|\b(npm|pnpm|yarn)\s+(publish|run\s+deploy)\b|\bpm2\b|\bssh\b|\bscp\b|\bdocker\b/i;

/** True when the action cannot change anything, so it is not worth a classifier call. */
export function isReadOnlyAction(toolName: string, toolInput: unknown): boolean {
  if (READ_ONLY_TOOLS.has(toolName)) return true;
  // Running a script is never read-only: its contents decide what it does.
  if (scriptContentsOf((toolInput ?? {}) as Record<string, unknown>).length > 0) return false;
  if (toolName === "Bash" || toolName === "Terminal") {
    const command = typeof (toolInput as { command?: unknown })?.command === "string"
      ? ((toolInput as { command: string }).command)
      : "";
    if (!command.trim()) return true;
    if (MUTATING_BASH_MARKERS.test(command)) return false;
    // Compound commands are only read-only when every part is.
    const parts = command.split(/&&|\|\||;|\n/).map((part) => part.trim()).filter(Boolean);
    return parts.every((part) => {
      const head = part.split("|")[0]!.trim();
      return READ_ONLY_BASH.test(head) || /^\s*curl\b/i.test(head) || /^\s*cd\b/.test(head);
    });
  }
  return false;
}

/** Credentials typed into a command are never stored, shown, or sent to the classifier. */
function withoutSecrets(text: string): string {
  return redactWithMatchers([{ kind: "secret" }], text);
}

/** The tool input with any credentials in a shell command redacted. */
export function safeToolInput(toolInput: unknown): unknown {
  if (toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)) {
    const record = toolInput as Record<string, unknown>;
    const scripts = scriptContentsOf(record);
    if (typeof record.command === "string" || scripts.length > 0) {
      return {
        ...record,
        ...(typeof record.command === "string" ? { command: withoutSecrets(record.command) } : {}),
        ...(scripts.length > 0
          ? { scriptContents: scripts.map((script) => ({ path: script.path, content: withoutSecrets(script.content) })) }
          : {}),
      };
    }
  }
  return toolInput;
}

/** Script files a Bash command runs, as read by the agent-side hook. */
function scriptContentsOf(record: Record<string, unknown>): Array<{ path: string; content: string }> {
  const raw = record.scriptContents;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is { path: string; content: string } =>
      Boolean(entry) && typeof (entry as { path?: unknown }).path === "string" && typeof (entry as { content?: unknown }).content === "string")
    .slice(0, 5);
}

const NON_SEMANTIC_INPUT_KEYS = new Set(["description", "timeout", "run_in_background", "dangerouslyDisableSandbox"]);

/**
 * The fingerprint an approval is tied to: the tool plus the parts of its input
 * that change what it does. Claude Code adds fields like `description` that
 * vary between attempts of the same action, so they are left out, and shell
 * whitespace is normalised.
 */
export function actionFingerprint(toolName: string, toolInput: unknown): string {
  if (toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)) {
    const record = toolInput as Record<string, unknown>;
    if (typeof record.command === "string") {
      // The scripts a command runs are part of what it does: approving
      // "bash x.sh" must not approve a different x.sh written afterwards.
      const scripts = scriptContentsOf(record).map((script) => ({
        path: script.path,
        content: withoutSecrets(script.content).replace(/\s+/g, " ").trim(),
      }));
      return hashToolValue({
        toolName,
        command: withoutSecrets(record.command).replace(/\s+/g, " ").trim(),
        ...(scripts.length > 0 ? { scripts } : {}),
      });
    }
    const semantic = Object.fromEntries(Object.entries(record).filter(([key]) => !NON_SEMANTIC_INPUT_KEYS.has(key)));
    return hashToolValue({ toolName, toolInput: semantic });
  }
  return hashToolValue({ toolName, toolInput: toolInput ?? null });
}

function summarizeInput(toolInput: unknown): string {
  let text: string;
  try {
    text = typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput, null, 1);
  } catch {
    text = String(toolInput);
  }
  return text.length > 6000 ? `${text.slice(0, 6000)}\n…(truncated)` : text;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export interface ClassifierCall {
  rules: AgentRule[];
  agentName: string;
  issueTitle: string | null;
  toolName: string;
  toolInput: unknown;
}

export interface ClassifierVerdict {
  decision: ActionReviewDecision;
  ruleId: string | null;
  reason: string;
}

export type ClassifierFn = (call: ClassifierCall) => Promise<ClassifierVerdict>;

const CLASSIFIER_SYSTEM = `You are a guardrail classifier for autonomous AI agents in a company's agent studio. Before an agent's action runs, you decide whether it breaks any of the company's rules.

Answer with JSON only: {"decision":"allow"|"deny"|"approval","ruleId":"<id of the rule it breaks, or null>","reason":"<one or two sentences addressed to the agent>"}

- "allow": the action does not break any rule. Most actions are allowed; do not invent violations.
- "deny": the action clearly breaks a rule whose enforcement is "block". Explain which rule and what the agent should do instead.
- "approval": the action breaks a rule whose enforcement is "require_approval" (a human must approve it first).
Judge the action's real effect (e.g. a curl POST that creates an issue, a git push, a config change), not keywords. When unsure, allow.
- If the input has "scriptContents", the command runs those script files: judge what the scripts do, not just the command line.
- Writing or editing a file whose content performs an action that breaks a rule (e.g. a script that changes an agent's config) counts as that action: treat it the same as running it.`;

/** Default classifier: an Anthropic-compatible Messages call on the agents' own provider (MiniMax on prod). */
export const defaultClassifier: ClassifierFn = async (call) => {
  // A dedicated classifier provider can be set; otherwise the agents' own
  // Anthropic-compatible provider (MiniMax on prod) is used.
  const provider = resolveClaudeProviderEnv();
  const baseUrl = process.env.GUARDRAIL_CLASSIFIER_BASE_URL ?? provider.baseUrl ?? "https://api.anthropic.com";
  const token = process.env.GUARDRAIL_CLASSIFIER_API_KEY ?? provider.token;
  if (!token) throw new Error("no provider key for the guardrail classifier");
  const model = process.env.GUARDRAIL_CLASSIFIER_MODEL ?? process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";
  const rulesText = call.rules
    .map((rule) => `- id=${rule.id} [${rule.action === "block" ? "block" : "require_approval"}] ${rule.name}: ${rule.rule}`)
    .join("\n");
  const user = `Company rules:\n${rulesText}\n\nAgent: ${call.agentName}\nCurrent task: ${call.issueTitle ?? "(none)"}\n\nAction about to run:\ntool: ${call.toolName}\ninput:\n${summarizeInput(call.toolInput)}`;
  // Thinking models (MiniMax) can spend the whole budget reasoning and never
  // write the answer, so give them room and retry once if no JSON comes back:
  // a classifier error lets the action through.
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": token,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: CLASSIFIER_SYSTEM,
        messages: [{ role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) {
      lastError = new Error(`classifier HTTP ${response.status}`);
      continue;
    }
    const body = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
    const text = (body.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
    const match = /\{[\s\S]*\}/.exec(text);
    if (!match) {
      lastError = new Error("classifier returned no JSON");
      continue;
    }
    try {
      const parsed = JSON.parse(match[0]) as Record<string, unknown>;
      const decision = parsed.decision === "deny" || parsed.decision === "approval" ? parsed.decision : "allow";
      return { decision, ruleId: readString(parsed.ruleId), reason: readString(parsed.reason) ?? "" };
    } catch {
      lastError = new Error("classifier returned invalid JSON");
    }
  }
  throw lastError ?? new Error("classifier failed");
};

let classifier: ClassifierFn = defaultClassifier;
/** Tests only. */
/** The classifier in use (the default, or a test stand-in). */
export function activeGuardrailClassifier(): ClassifierFn {
  return classifier;
}

export function setGuardrailClassifierForTests(fn: ClassifierFn | null) {
  classifier = fn ?? defaultClassifier;
}

export function guardrailActionReviewService(db: Db) {
  const guardrails = guardrailService(db);

  async function agentRules(companyId: string, agentId: string): Promise<AgentRule[]> {
    const rows = await db
      .select()
      .from(guardrailPolicies)
      .where(
        and(
          eq(guardrailPolicies.companyId, companyId),
          eq(guardrailPolicies.kind, "rule"),
          eq(guardrailPolicies.enabled, true),
          inArray(guardrailPolicies.scopeType, ["company", "agent"]),
        ),
      );
    return rows
      .filter((row) => row.scopeType === "company" || row.scopeId === agentId)
      .map((row) => ({
        id: row.id,
        name: row.name,
        rule: readString((row.matcher as Record<string, unknown>)?.rule) ?? row.name,
        action: row.action,
      }));
  }

  /** The text injected into the agent's context at session start. */
  async function agentRulesContext(companyId: string, agentId: string): Promise<string | null> {
    const rules = await agentRules(companyId, agentId);
    if (rules.length === 0) return null;
    return [
      "BOARD GUARDRAILS — rules you must follow in this company. Plan your work within them.",
      "Every action you take is reviewed against these rules before it runs. An action that breaks a rule is denied (you get the reason) or held for board approval.",
      "When an action needs approval, stop that line of work and wait; do not look for another way to do the same thing.",
      "",
      ...rules.map((rule) => `- ${rule.rule}${rule.action === "require_approval" ? " (needs board approval)" : ""}`),
    ].join("\n");
  }

  async function issueForRun(runId: string | null): Promise<{ id: string; title: string } | null> {
    if (!runId) return null;
    const run = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    const snapshot = (run?.contextSnapshot ?? {}) as Record<string, unknown>;
    const issueId = readString(snapshot.issueId) ?? readString(snapshot.taskId);
    if (!issueId) return null;
    return db
      .select({ id: issues.id, title: issues.title })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
  }

  async function park(input: {
    companyId: string;
    agentId: string;
    agentName: string;
    runId: string | null;
    issueId: string | null;
    toolName: string;
    toolInput: unknown;
    argumentsHash: string;
    policyId: string | null;
    policyName: string;
    reason: string;
  }): Promise<string | null> {
    const [approval] = await db
      .insert(approvals)
      .values({
        companyId: input.companyId,
        type: "guardrail_action",
        requestedByAgentId: input.agentId,
        status: "pending",
        payload: {
          title: `${input.agentName}: ${input.toolName} needs approval`,
          summary: input.reason,
          recommendedAction: "Approve to let the agent run exactly this action once; reject to stop it.",
          source: "guardrails",
          agentAction: true,
          tool: input.toolName,
          arguments: safeToolInput(input.toolInput),
          argumentsHash: input.argumentsHash,
          agentId: input.agentId,
          runId: input.runId,
          issueId: input.issueId,
          policyId: input.policyId,
          policyName: input.policyName,
          stage: "action",
        },
      })
      .returning();
    if (approval && input.issueId) {
      await db
        .insert(issueApprovals)
        .values({ companyId: input.companyId, issueId: input.issueId, approvalId: approval.id, linkedByAgentId: input.agentId })
        .onConflictDoNothing();
    }
    return approval?.id ?? null;
  }

  async function reviewAction(input: {
    companyId: string;
    agentId: string;
    runId: string | null;
    toolName: string;
    toolInput: unknown;
  }): Promise<ActionReviewResult> {
    const { companyId, agentId, runId, toolName } = input;
    const toolInput = safeToolInput(input.toolInput);
    if (isReadOnlyAction(toolName, toolInput)) return { decision: "allow", reason: null, source: "read_only" };

    const argumentsHash = actionFingerprint(toolName, toolInput);

    // A board approval for exactly this action releases it once.
    const prior = await guardrails.findGuardrailApproval({
      companyId,
      toolName,
      argumentsHash,
      agentId,
      statuses: ["approved", "rejected", "pending"],
    });
    if (prior?.status === "approved" && !prior.consumed && (await guardrails.consumeGuardrailApproval(prior.approvalId))) {
      return { decision: "allow", reason: null, source: "approved", approvalId: prior.approvalId };
    }
    if (prior?.status === "rejected") {
      return {
        decision: "deny",
        reason: "The board rejected this exact action. Do not retry it or find another way to do the same thing.",
        approvalId: prior.approvalId,
        source: "policy",
      };
    }
    if (prior?.status === "pending") {
      return {
        decision: "deny",
        reason: `This action is waiting for board approval (${prior.approvalId}). Stop this line of work and end the run; you will be woken when the board decides.`,
        approvalId: prior.approvalId,
        source: "policy",
      };
    }

    const agent = await db
      .select({ name: agents.name })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    const agentName = agent?.name ?? "Agent";
    const issue = await issueForRun(runId);

    // Deterministic action policies (restricted_action / regex) on the tool and its input.
    const toolText = summarizeInput(toolInput);
    const decision = await guardrails.applyGuardrails(
      {
        companyId,
        agentId,
        text: typeof (toolInput as { command?: unknown })?.command === "string" ? (toolInput as { command: string }).command : toolText,
        fields: { tool_args: toolText },
        toolName,
        toolArguments: toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) ? (toolInput as Record<string, unknown>) : null,
      },
      { stage: "action", violation: { subjectKind: "tool_action", actorAgentId: agentId, heartbeatRunId: runId } },
    );
    const decisive = decision.decisive;
    if (decision.action === "block") {
      return {
        decision: "deny",
        reason: `Blocked by board guardrail "${decisive?.policyName ?? "policy"}". Do not try to do this another way.`,
        policyName: decisive?.policyName ?? null,
        source: "policy",
      };
    }
    if (decision.action === "require_approval") {
      const reason = `"${decisive?.policyName ?? "policy"}" requires board approval for this action.`;
      const approvalId = await park({ companyId, agentId, agentName, runId, issueId: issue?.id ?? null, toolName, toolInput, argumentsHash, policyId: decisive?.policyId ?? null, policyName: decisive?.policyName ?? "policy", reason });
      return {
        decision: "approval",
        reason: `${reason} An approval was requested (${approvalId}). Stop this line of work and end the run; you will be woken when the board decides.`,
        approvalId,
        policyName: decisive?.policyName ?? null,
        source: "policy",
      };
    }

    // Plain-English rules, judged by the classifier.
    const rules = await agentRules(companyId, agentId);
    if (rules.length === 0) return { decision: "allow", reason: null, source: "no_rules" };
    let verdict: ClassifierVerdict;
    try {
      verdict = await classifier({ rules, agentName, issueTitle: issue?.title ?? null, toolName, toolInput });
    } catch (error) {
      // Fail open so a provider outage cannot freeze every agent; logged for the board.
      logger.warn({ err: error, companyId, agentId, toolName }, "guardrail classifier failed; allowing the action");
      return { decision: "allow", reason: null, source: "error" };
    }
    if (verdict.decision === "allow") return { decision: "allow", reason: null, source: "classifier" };

    const rule = rules.find((entry) => entry.id === verdict.ruleId) ?? rules[0]!;
    // A "deny" on a require_approval rule is still an approval request, and vice versa.
    const effective: ActionReviewDecision = rule.action === "require_approval" ? "approval" : "deny";
    await guardrails.recordViolation({
      companyId,
      policyId: rule.id,
      policyVersion: null,
      stage: "action",
      actionTaken: effective === "approval" ? "require_approval" : "block",
      actorAgentId: agentId,
      heartbeatRunId: runId,
      subjectKind: "tool_action",
      subjectId: issue?.id ?? null,
      matchedExcerpt: `${toolName}: ${verdict.reason}`.slice(0, 200),
    });
    if (effective === "deny") {
      return {
        decision: "deny",
        reason: `Board guardrail "${rule.name}": ${verdict.reason || rule.rule} Do not try to do this another way.`,
        policyName: rule.name,
        source: "classifier",
      };
    }
    const reason = `Board guardrail "${rule.name}" requires approval: ${verdict.reason || rule.rule}`;
    const approvalId = await park({ companyId, agentId, agentName, runId, issueId: issue?.id ?? null, toolName, toolInput, argumentsHash, policyId: rule.id, policyName: rule.name, reason });
    return {
      decision: "approval",
      reason: `${reason} An approval was requested (${approvalId}). Stop this line of work and end the run; you will be woken when the board decides.`,
      approvalId,
      policyName: rule.name,
      source: "classifier",
    };
  }

  return { reviewAction, agentRules, agentRulesContext };
}
