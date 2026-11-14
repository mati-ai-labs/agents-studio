/**
 * Guardrail policy engine.
 *
 * A guardrail policy is a stored, company-scoped rule that decides what the
 * studio does when a subject matches: `redact`, `block`, or `require_approval`.
 *
 * The engine is deliberately split into three layers so each can be tested in
 * isolation:
 *
 *   1. `resolveEffectivePolicies` — which policies apply to a subject, given
 *      the company and the agent/project/goal the subject belongs to.
 *   2. `evaluatePolicy` — does a single policy match a subject?
 *   3. `applyGuardrails` — run every effective policy and fold the matches
 *      into a single decision.
 *
 * Scope precedence is company < agent < project < goal: a more specific scope
 * wins when two policies of the same kind conflict. The winning policy is the
 * one whose action is applied; the loser is still recorded on the violation
 * row so an operator can see what was overridden.
 */
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, guardrailPolicies, guardrailViolations, heartbeatRuns } from "@paperclipai/db";
import type {
  GuardrailPolicyAction,
  GuardrailPolicyKind,
  GuardrailPolicyScopeType,
  GuardrailPolicySeverity,
  GuardrailPolicyStage,
  GuardrailViolationSubjectKind,
} from "@paperclipai/shared";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { FREE_TEXT_PATTERNS } from "./feedback-redaction.js";
import { hashToolValue } from "./tool-content-guards.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

/**
 * The marker a guardrail policy writes into text it redacts.
 *
 * A guardrail redacts prose in place — an issue comment, a document body, a
 * tool result an agent reads — and the studio already has one marker for a
 * redacted value: `REDACTED_EVENT_VALUE`. Reusing it means a reader (or a
 * filter) that recognises the studio's redaction marker recognises the
 * guardrail's too, whatever surface the redacted text ends up on.
 */
const GUARDRAIL_REDACTION_MARKER = REDACTED_EVENT_VALUE;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GuardrailSubject {
  /** Company that owns the subject. */
  companyId: string;
  /** Agent the subject is attributed to, when known. */
  agentId?: string | null;
  projectId?: string | null;
  goalId?: string | null;
  /** Free text the policy is matched against (comment body, document body...). */
  text?: string | null;
  /** Additional named fields a policy can restrict matching to. */
  fields?: Record<string, string> | null;
  /** Tool name for `action`-stage subjects. */
  toolName?: string | null;
  /** Connector type for `action`-stage subjects. */
  connectorType?: string | null;
  /** Tool arguments for `action`-stage subjects. */
  toolArguments?: Record<string, unknown> | null;
}

export interface GuardrailMatch {
  policyId: string;
  policyName: string;
  kind: GuardrailPolicyKind;
  action: GuardrailPolicyAction;
  severity: GuardrailPolicySeverity;
  scopeType: GuardrailPolicyScopeType;
  scopeId: string | null;
  policyVersion: number;
  /** Which field of the subject matched, when the matcher restricted the fields. */
  matchedField: string | null;
  /** Already-redacted excerpt of what matched. Never raw subject text. */
  excerpt: string;
}

export interface GuardrailDecision {
  /** The action the studio takes. `allow` when nothing matched. */
  action: GuardrailPolicyAction;
  /** Policy that determined the action, when the action is not `allow`. */
  decisive: GuardrailMatch | null;
  /** Every policy that matched, ordered most to least severe. */
  matches: GuardrailMatch[];
  /**
   * The subject text with every matched `redact` policy applied (not just the
   * last one), when a `redact` policy matched.
   */
  redactedText: string | null;
  /**
   * Matchers of every `redact` policy that matched, so a caller can apply the
   * same redaction to text it holds in a different shape (an MCP tool result's
   * content parts, for instance) via `redactWithMatchers`.
   */
  redactionMatchers: Record<string, unknown>[];
}

export interface GuardrailViolationInput {
  companyId: string;
  policyId: string | null;
  policyVersion: number | null;
  stage: GuardrailPolicyStage;
  actionTaken: GuardrailPolicyAction;
  actorAgentId?: string | null;
  heartbeatRunId?: string | null;
  subjectKind: GuardrailViolationSubjectKind;
  subjectId?: string | null;
  matchedExcerpt?: string | null;
}

// ---------------------------------------------------------------------------
// Matching primitives
// ---------------------------------------------------------------------------

const EXCERPT_MAX_LENGTH = 200;

/** A pattern the author supplied that does not compile is skipped, not fatal. */
function toSafeRegExp(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

/**
 * The redaction patterns the studio already recognises, keyed by the `kind`
 * the feedback redaction module gives them.
 *
 * The guardrail engine deliberately reuses these rather than declaring its
 * own: a second, near-duplicate set of credential and PII regular expressions
 * would drift from the ones the studio actually applies everywhere else, and
 * would let a policy claim to catch a secret the rest of the product misses.
 */
const SHARED_PATTERN_KINDS = new Map<string, RegExp>(
  FREE_TEXT_PATTERNS.map((pattern) => [pattern.kind, pattern.regex]),
);

/** The PII families a `pii` policy can select. */
const PII_PATTERN_KINDS = ["email", "phone"] as const;

/**
 * The credential families a `secret` policy can select. `pem_block` covers
 * private keys, so it is listed under its own name rather than a `private_key`
 * alias the repo does not use.
 */
const SECRET_PATTERN_KINDS = [
  "pem_block",
  "secret_assignment",
  "bearer_token",
  "github_token",
  "provider_api_key",
  "jwt",
  "dsn",
] as const;

/**
 * The patterns for a set of family names. A family the studio does not
 * recognise contributes no pattern, so an unknown name in `piiTypes` matches
 * nothing rather than silently matching everything.
 */
function patternsForFamilies(families: readonly string[]): RegExp[] {
  const patterns: RegExp[] = [];
  for (const family of families) {
    const regex = SHARED_PATTERN_KINDS.get(family);
    if (!regex) continue;
    patterns.push(new RegExp(regex.source, regex.flags));
  }
  return patterns;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Renders tool arguments as text for the matcher. Never throws: a value that
 * cannot be serialised is represented by its type name rather than crashing
 * the tool call.
 */
function safeStringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * Thrown when a guardrail policy blocks a tool call or a tool result.
 *
 * The message names the policy that fired so the agent can adapt rather than
 * retry blindly.
 */
export class GuardrailBlockedError extends Error {
  constructor(
    message: string,
    public readonly details: {
      code: string;
      policyId: string | null;
      policyName: string | null;
      stage: GuardrailPolicyStage;
      action: GuardrailPolicyAction;
    },
  ) {
    super(message);
    this.name = "GuardrailBlockedError";
  }
}

/**
 * Reads a dotted path out of a nested object. `a.b.c` walks three levels.
 */
function readPath(source: unknown, path: string): unknown {
  const segments = path.split(".").filter((segment) => segment.length > 0);
  let current: unknown = source;
  for (const segment of segments) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * The candidate strings a matcher can be applied to, keyed by field name.
 *
 * A matcher that names no `fields` applies to every candidate, so `any` plus
 * the subject's own fields are all considered.
 */
function candidateTexts(subject: GuardrailSubject): Record<string, string> {
  const candidates: Record<string, string> = {};
  const push = (name: string, value: string | null | undefined) => {
    if (typeof value === "string" && value.length > 0) candidates[name] = value;
  };
  push("any", subject.text);
  push("tool_result", subject.text);
  for (const [name, value] of Object.entries(subject.fields ?? {})) {
    push(name, value);
  }
  if (subject.toolName) push("tool_name", subject.toolName);
  if (subject.connectorType) push("tool_name", subject.connectorType);
  const args = subject.toolArguments;
  if (isPlainObject(args)) {
    for (const [name, value] of Object.entries(args)) {
      if (typeof value === "string") push("tool_args", value);
      else if (value !== null && value !== undefined) push("tool_args", JSON.stringify(value));
    }
  }
  return candidates;
}

/**
 * The field names a matcher applies to, or `null` when it applies to all of
 * them.
 */
function matcherFields(matcher: Record<string, unknown>): string[] | null {
  const raw = matcher.fields;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const names = raw.filter((value): value is string => typeof value === "string");
  return names.length > 0 ? names : null;
}

/**
 * The subject values a matcher is tested against, given its `fields`
 * restriction. `tool_args` and `tool_name` are matched against the tool
 * metadata rather than the free-text candidates.
 */
function textsForMatcher(
  subject: GuardrailSubject,
  fields: string[] | null,
): Array<{ field: string; text: string }> {
  const candidates = candidateTexts(subject);
  const entries = Object.entries(candidates);
  if (!fields) return entries.map(([field, text]) => ({ field, text }));
  const selected: Array<{ field: string; text: string }> = [];
  for (const field of fields) {
    if (field === "any") {
      for (const [name, text] of entries) selected.push({ field: name, text });
      continue;
    }
    const text = candidates[field];
    if (text !== undefined) selected.push({ field, text });
  }
  return selected;
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  const slice = text.slice(start, end);
  return slice.length > EXCERPT_MAX_LENGTH ? `${slice.slice(0, EXCERPT_MAX_LENGTH)}…` : slice;
}

// ---------------------------------------------------------------------------
// Policy evaluation
// ---------------------------------------------------------------------------

interface PolicyMatcherResult {
  matched: boolean;
  field: string | null;
  excerpt: string;
  /** The subject text with every match redacted, used by the `redact` action. */
  redactedText: string;
}

/**
 * Applies one matcher to one candidate text.
 *
 * Every pattern is scanned against the original text first and the
 * replacements are applied back to front, so a pattern that matches early in
 * the text cannot shift the offsets of a pattern that matches later. Without
 * that, two overlapping families would redact the wrong span.
 */
function applyPatterns(
  text: string,
  patterns: RegExp[],
): { matched: boolean; index: number; length: number; excerpt: string; redactedText: string } {
  const spans: Array<{ start: number; end: number }> = [];

  for (const pattern of patterns) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const scanner = new RegExp(pattern.source, flags);
    for (const match of text.matchAll(scanner)) {
      const index = match.index ?? 0;
      const value = match[0];
      if (value.length === 0) continue;
      spans.push({ start: index, end: index + value.length });
    }
  }

  if (spans.length === 0) {
    return { matched: false, index: -1, length: 0, excerpt: "", redactedText: text };
  }

  spans.sort((left, right) => left.start - right.start || left.end - right.end);

  // Overlapping spans would otherwise redact twice over the same characters.
  const merged: Array<{ start: number; end: number }> = [];
  for (const span of spans) {
    const previous = merged[merged.length - 1];
    if (previous && span.start < previous.end) {
      previous.end = Math.max(previous.end, span.end);
      continue;
    }
    merged.push({ ...span });
  }

  let redactedText = text;
  for (let index = merged.length - 1; index >= 0; index -= 1) {
    const span = merged[index]!;
    redactedText =
      redactedText.slice(0, span.start) + GUARDRAIL_REDACTION_MARKER + redactedText.slice(span.end);
  }

  const first = merged[0]!;
  const excerpt = sanitizeExcerpt(excerptAround(text, first.start, first.end - first.start));

  return {
    matched: true,
    index: first.start,
    length: first.end - first.start,
    excerpt,
    redactedText,
  };
}

/**
 * Every pattern the studio recognises, used to strip PII and credentials out
 * of an excerpt before it is stored.
 */
const SANITIZING_PATTERN_KINDS = [
  ...PII_PATTERN_KINDS,
  ...SECRET_PATTERN_KINDS,
] as const;

/**
 * Removes PII and credentials from an excerpt.
 *
 * A violation row is meant to explain what a policy matched without becoming
 * a second copy of the sensitive data it caught, so the excerpt is scrubbed
 * with the same patterns the policies themselves use.
 */
function sanitizeExcerpt(text: string): string {
  let output = text;
  for (const pattern of patternsForFamilies(SANITIZING_PATTERN_KINDS)) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    output = output.replace(new RegExp(pattern.source, flags), GUARDRAIL_REDACTION_MARKER);
  }
  return output;
}

function evaluatePiiMatcher(
  matcher: Record<string, unknown>,
  text: string,
): { matched: boolean; excerpt: string; redactedText: string } {
  const requested = Array.isArray(matcher.piiTypes)
    ? matcher.piiTypes.filter((value): value is string => typeof value === "string")
    : [];
  const families = requested.length > 0 ? requested : PII_PATTERN_KINDS;
  const patterns = patternsForFamilies(families);
  if (patterns.length === 0) return { matched: false, excerpt: "", redactedText: text };
  const result = applyPatterns(text, patterns);
  return { matched: result.matched, excerpt: result.excerpt, redactedText: result.redactedText };
}

function evaluateSecretMatcher(
  matcher: Record<string, unknown>,
  text: string,
): { matched: boolean; excerpt: string; redactedText: string } {
  const requested = Array.isArray(matcher.secretTypes)
    ? matcher.secretTypes.filter((value): value is string => typeof value === "string")
    : [];
  const families = requested.length > 0 ? requested : SECRET_PATTERN_KINDS;
  const patterns = patternsForFamilies(families);
  if (patterns.length === 0) return { matched: false, excerpt: "", redactedText: text };
  const result = applyPatterns(text, patterns);
  return { matched: result.matched, excerpt: result.excerpt, redactedText: result.redactedText };
}

/**
 * The patterns a text matcher redacts with. `restricted_action` and
 * `allowlist` matchers do not name a span, so they redact nothing.
 */
function matcherRedactionPatterns(matcher: Record<string, unknown>): RegExp[] {
  const kind = matcher.kind;
  if (kind === "pii") {
    const requested = Array.isArray(matcher.piiTypes)
      ? matcher.piiTypes.filter((value): value is string => typeof value === "string")
      : [];
    return patternsForFamilies(requested.length > 0 ? requested : PII_PATTERN_KINDS);
  }
  if (kind === "secret") {
    const requested = Array.isArray(matcher.secretTypes)
      ? matcher.secretTypes.filter((value): value is string => typeof value === "string")
      : [];
    return patternsForFamilies(requested.length > 0 ? requested : SECRET_PATTERN_KINDS);
  }
  if (kind === "regex") {
    const patterns = Array.isArray(matcher.patterns)
      ? matcher.patterns.filter((value): value is string => typeof value === "string")
      : [];
    return patterns
      .map((pattern) => toSafeRegExp(pattern))
      .filter((pattern): pattern is RegExp => pattern !== null);
  }
  return [];
}

/**
 * Applies every given matcher's redaction to `text` in one pass, so two
 * `redact` policies (say, emails and a codename) both take effect.
 */
export function redactWithMatchers(matchers: Record<string, unknown>[], text: string): string {
  if (!text || matchers.length === 0) return text;
  const patterns = matchers.flatMap((matcher) => matcherRedactionPatterns(matcher));
  if (patterns.length === 0) return text;
  return applyPatterns(text, patterns).redactedText;
}

/**
 * The text an agent will read from a tool result. Handles a plain string,
 * `{ content: string }`, and the MCP shape `{ content: [{ type: "text", text }] }`.
 * Anything else is stringified so a policy can still match on it.
 */
export function toolResultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (isPlainObject(value)) {
    const content = value.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => (isPlainObject(part) && typeof part.text === "string" ? part.text : ""))
        .filter((text) => text.length > 0)
        .join("\n");
    }
  }
  if (value === null || value === undefined) return "";
  return safeStringify(value);
}

/**
 * Rewrites the text inside a tool result, keeping its shape: a string, a
 * `{ content: string }` object, or MCP text content parts. Other shapes are
 * rewritten through their JSON form.
 */
export function mapToolResultText(value: unknown, transform: (text: string) => string): unknown {
  if (typeof value === "string") return transform(value);
  if (isPlainObject(value)) {
    const content = value.content;
    if (typeof content === "string") return { ...value, content: transform(content) };
    if (Array.isArray(content)) {
      return {
        ...value,
        content: content.map((part) =>
          isPlainObject(part) && typeof part.text === "string" ? { ...part, text: transform(part.text) } : part,
        ),
      };
    }
  }
  if (value === null || value === undefined) return value;
  const json = safeStringify(value);
  const transformed = transform(json);
  if (transformed === json) return value;
  try {
    return JSON.parse(transformed);
  } catch {
    return transformed;
  }
}

/**
 * `restricted_action` matches on the tool being called rather than on free
 * text: the tool name, the connector type, or the shape of the arguments.
 */
function evaluateRestrictedActionMatcher(
  matcher: Record<string, unknown>,
  subject: GuardrailSubject,
): { matched: boolean; field: string | null; excerpt: string } {
  const toolNames = Array.isArray(matcher.toolNames)
    ? matcher.toolNames.filter((value): value is string => typeof value === "string")
    : [];
  const connectorTypes = Array.isArray(matcher.connectorTypes)
    ? matcher.connectorTypes.filter((value): value is string => typeof value === "string")
    : [];

  if (toolNames.length > 0 && subject.toolName) {
    const matched = toolNames.some((name) => name === subject.toolName);
    if (matched) return { matched: true, field: "tool_name", excerpt: subject.toolName };
  }
  if (connectorTypes.length > 0 && subject.connectorType) {
    const matched = connectorTypes.some((type) => type === subject.connectorType);
    if (matched) return { matched: true, field: "tool_name", excerpt: subject.connectorType };
  }

  const argumentPatterns = Array.isArray(matcher.argumentPatterns)
    ? matcher.argumentPatterns.filter(
        (value): value is { path: string; pattern: string } =>
          isPlainObject(value) && typeof value.path === "string" && typeof value.pattern === "string",
      )
    : [];
  for (const entry of argumentPatterns) {
    const raw = readPath(subject.toolArguments ?? {}, entry.path);
    if (raw === undefined || raw === null) continue;
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    const regex = toSafeRegExp(entry.pattern);
    if (!regex) continue;
    const match = regex.exec(text);
    if (match) {
      return {
        matched: true,
        field: "tool_args",
        excerpt: sanitizeExcerpt(excerptAround(text, match.index, match[0].length)),
      };
    }
  }
  return { matched: false, field: null, excerpt: "" };
}

/**
 * Evaluates a single policy matcher against a subject.
 */
function evaluateMatcher(
  matcher: Record<string, unknown>,
  subject: GuardrailSubject,
): PolicyMatcherResult {
  const kind = matcher.kind;

  if (kind === "restricted_action") {
    const result = evaluateRestrictedActionMatcher(matcher, subject);
    return {
      matched: result.matched,
      field: result.field,
      excerpt: result.excerpt,
      redactedText: subject.text ?? "",
    };
  }

  const fields = matcherFields(matcher);
  const candidates = textsForMatcher(subject, fields);

  for (const candidate of candidates) {
    if (kind === "pii") {
      const result = evaluatePiiMatcher(matcher, candidate.text);
      if (result.matched) {
        return {
          matched: true,
          field: candidate.field,
          excerpt: result.excerpt,
          redactedText: result.redactedText,
        };
      }
      continue;
    }
    if (kind === "secret") {
      const result = evaluateSecretMatcher(matcher, candidate.text);
      if (result.matched) {
        return {
          matched: true,
          field: candidate.field,
          excerpt: result.excerpt,
          redactedText: result.redactedText,
        };
      }
      continue;
    }
    if (kind === "allowlist") {
      const values = Array.isArray(matcher.values)
        ? matcher.values.filter((value): value is string => typeof value === "string")
        : [];
      if (values.length === 0) continue;
      // The allowlist inverts the decision: a candidate that is *not* listed
      // is what the policy matches.
      const listed = values.some((value) => candidate.text.trim() === value.trim());
      if (!listed) {
        return {
          matched: true,
          field: candidate.field,
          excerpt: sanitizeExcerpt(
            excerptAround(candidate.text, 0, Math.min(candidate.text.length, EXCERPT_MAX_LENGTH)),
          ),
          redactedText: candidate.text,
        };
      }
      continue;
    }
    if (kind === "regex") {
      const patterns = Array.isArray(matcher.patterns)
        ? matcher.patterns.filter((value): value is string => typeof value === "string")
        : [];
      const compiled = patterns
        .map((pattern) => toSafeRegExp(pattern))
        .filter((pattern): pattern is RegExp => pattern !== null);
      if (compiled.length === 0) continue;
      const result = applyPatterns(candidate.text, compiled);
      if (result.matched) {
        return {
          matched: true,
          field: candidate.field,
          excerpt: result.excerpt,
          redactedText: result.redactedText,
        };
      }
      continue;
    }
  }

  return { matched: false, field: null, excerpt: "", redactedText: subject.text ?? "" };
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

/** Company < agent < project < goal. A larger number wins a conflict. */
const SCOPE_PRECEDENCE: Record<GuardrailPolicyScopeType, number> = {
  company: 0,
  agent: 1,
  project: 2,
  goal: 3,
};

const SEVERITY_PRECEDENCE: Record<GuardrailPolicySeverity, number> = {
  info: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export interface EffectivePolicy {
  policy: {
    id: string;
    companyId: string;
    scopeType: GuardrailPolicyScopeType;
    scopeId: string | null;
    stage: GuardrailPolicyStage;
    name: string;
    description: string | null;
    kind: GuardrailPolicyKind;
    matcher: Record<string, unknown>;
    action: GuardrailPolicyAction;
    severity: GuardrailPolicySeverity;
    enabled: boolean;
    version: number;
  };
}

/**
 * Returns the policies that apply to a subject.
 *
 * A policy applies when its scope matches the subject's scope: a company-scoped
 * policy always applies, and a policy scoped to an agent/project/goal applies
 * only when the subject belongs to that scope.
 */
export async function resolveEffectivePolicies(
  db: Db,
  input: {
    companyId: string;
    stage: GuardrailPolicyStage;
    agentId?: string | null;
    projectId?: string | null;
    goalId?: string | null;
    scopeTypes?: GuardrailPolicyScopeType[];
    scopeIds?: string[];
  },
): Promise<EffectivePolicy[]> {
  const rows = await db
    .select()
    .from(guardrailPolicies)
    .where(
      and(
        eq(guardrailPolicies.companyId, input.companyId),
        eq(guardrailPolicies.stage, input.stage),
        eq(guardrailPolicies.enabled, true),
      ),
    )
    .orderBy(asc(guardrailPolicies.createdAt));

  const scopeTypes = input.scopeTypes ?? ["company", "agent", "project", "goal"];
  const scopeIds = new Set(input.scopeIds ?? []);

  return rows
    .filter((row) => {
      if (!scopeTypes.includes(row.scopeType)) return false;
      if (row.scopeType === "company") return true;
      if (!row.scopeId) return false;
      return scopeIds.has(row.scopeId);
    })
    .map((row) => ({ policy: row }));
}

/**
 * Builds the scope ids that apply to a subject, so a policy scoped to any of
 * the subject's scopes can match.
 */
function subjectScopeIds(subject: GuardrailSubject): string[] {
  const ids: string[] = [];
  if (subject.agentId) ids.push(subject.agentId);
  if (subject.projectId) ids.push(subject.projectId);
  if (subject.goalId) ids.push(subject.goalId);
  return ids;
}

/**
 * Evaluates one policy against one subject.
 */
export function evaluatePolicy(
  policy: EffectivePolicy["policy"],
  subject: GuardrailSubject,
): GuardrailMatch | null {
  const matcher = isPlainObject(policy.matcher) ? policy.matcher : {};
  const result = evaluateMatcher(matcher, subject);
  if (!result.matched) return null;
  return {
    policyId: policy.id,
    policyName: policy.name,
    kind: policy.kind,
    action: policy.action,
    severity: policy.severity,
    scopeType: policy.scopeType,
    scopeId: policy.scopeId,
    policyVersion: policy.version,
    matchedField: result.field,
    excerpt: result.excerpt,
  };
}

/**
 * Folds the matching policies into a single decision.
 *
 * The decisive policy is the one with the most specific scope; ties are broken
 * by severity, then by the stronger action.
 */
function decide(matches: GuardrailMatch[]): { action: GuardrailPolicyAction; decisive: GuardrailMatch | null } {
  if (matches.length === 0) return { action: "allow", decisive: null };

  const ACTION_STRENGTH: Record<GuardrailPolicyAction, number> = {
    allow: 0,
    redact: 1,
    require_approval: 2,
    block: 3,
  };

  const sorted = [...matches].sort((left, right) => {
    const scopeDelta =
      SCOPE_PRECEDENCE[right.scopeType] - SCOPE_PRECEDENCE[left.scopeType];
    if (scopeDelta !== 0) return scopeDelta;
    const severityDelta =
      SEVERITY_PRECEDENCE[right.severity] - SEVERITY_PRECEDENCE[left.severity];
    if (severityDelta !== 0) return severityDelta;
    return ACTION_STRENGTH[right.action] - ACTION_STRENGTH[left.action];
  });

  const decisive = sorted[0]!;
  return { action: decisive.action, decisive };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function guardrailService(db: Db) {
  const log = logger.child({ service: "guardrails" });

  /**
   * Returns the run id only when it names a run that belongs to the company.
   */
  async function resolveExistingRunId(companyId: string, runId?: string | null): Promise<string | null> {
    const normalized = typeof runId === "string" ? runId.trim() : "";
    if (!normalized) return null;
    const existing = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, normalized), eq(heartbeatRuns.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    return existing?.id ?? null;
  }

  /**
   * Returns the agent id only when it names an agent that belongs to the
   * company.
   */
  async function resolveExistingAgentId(companyId: string, agentId?: string | null): Promise<string | null> {
    const normalized = typeof agentId === "string" ? agentId.trim() : "";
    if (!normalized) return null;
    const existing = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, normalized), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    return existing?.id ?? null;
  }

  /**
   * Runs every effective policy against a subject and returns the decision.
   *
   * This is the single entry point every enforcement point calls, so the
   * resolution rules are identical wherever a policy is applied.
   */
  async function applyGuardrails(
    subject: GuardrailSubject,
    options: {
      stage: GuardrailPolicyStage;
      /** Policies to evaluate instead of the stored effective set. */
      policies?: EffectivePolicy[];
      /** Violation row to write when the decision is not `allow`. */
      violation?: Partial<GuardrailViolationInput> & { subjectKind: GuardrailViolationSubjectKind };
    },
  ): Promise<GuardrailDecision> {
    const policies =
      options.policies ??
      (await resolveEffectivePolicies(db, {
        companyId: subject.companyId,
        stage: options.stage,
        agentId: subject.agentId,
        projectId: subject.projectId,
        goalId: subject.goalId,
        scopeIds: subjectScopeIds(subject),
      }));

    const matches: GuardrailMatch[] = [];
    const redactionMatchers: Record<string, unknown>[] = [];

    for (const entry of policies) {
      const match = evaluatePolicy(entry.policy, subject);
      if (!match) continue;
      matches.push(match);
      if (entry.policy.action === "redact" && isPlainObject(entry.policy.matcher)) {
        redactionMatchers.push(entry.policy.matcher);
      }
    }

    // Every matched redact policy is applied, not just the last one: with an
    // email policy and a codename policy, both spans must be redacted.
    const redactedText =
      redactionMatchers.length > 0 && subject.text
        ? redactWithMatchers(redactionMatchers, subject.text)
        : null;

    const { action, decisive } = decide(matches);

    if (action !== "allow" && options.violation) {
      await recordViolation({
        ...options.violation,
        companyId: subject.companyId,
        stage: options.stage,
        actionTaken: action,
        policyId: decisive?.policyId ?? null,
        policyVersion: decisive?.policyVersion ?? null,
        matchedExcerpt: decisive?.excerpt ?? null,
        actorAgentId: subject.agentId ?? null,
      });
    }

    return {
      action,
      decisive,
      matches: matches.sort((left, right) => {
        const scopeDelta =
          SCOPE_PRECEDENCE[right.scopeType] - SCOPE_PRECEDENCE[left.scopeType];
        if (scopeDelta !== 0) return scopeDelta;
        return SEVERITY_PRECEDENCE[right.severity] - SEVERITY_PRECEDENCE[left.severity];
      }),
      redactedText,
      redactionMatchers,
    };
  }

  /**
   * Writes a violation row. Failures are logged, never thrown: an audit write
   * must not turn a working enforcement decision into a server error.
   */
  async function recordViolation(input: GuardrailViolationInput) {
    try {
      // The run and agent ids come from the caller, so they may name rows
      // that no longer exist. Resolving them against the tables first keeps
      // the insert from failing on a foreign key — a violation must be
      // recorded even when the run that caused it has been pruned.
      const heartbeatRunId = await resolveExistingRunId(input.companyId, input.heartbeatRunId);
      const actorAgentId = await resolveExistingAgentId(input.companyId, input.actorAgentId);

      const [violation] = await db
        .insert(guardrailViolations)
        .values({
          companyId: input.companyId,
          policyId: input.policyId,
          policyVersion: input.policyVersion,
          stage: input.stage,
          actionTaken: input.actionTaken,
          actorAgentId,
          heartbeatRunId,
          subjectKind: input.subjectKind,
          subjectId: input.subjectId ?? null,
          matchedExcerpt: input.matchedExcerpt ?? null,
        })
        .returning();

      // The violation row is the queryable record; the activity-log entry is
      // what puts the decision in the timeline an operator already reads. Both
      // carry the run id so a decision can be traced back to the run that
      // triggered it.
      await logActivity(db, {
        companyId: input.companyId,
        actorType: actorAgentId ? "agent" : "system",
        actorId: actorAgentId ?? "guardrails",
        agentId: actorAgentId,
        runId: heartbeatRunId,
        action: `guardrail.${input.actionTaken}`,
        entityType: "guardrail_violation",
        entityId: violation?.id ?? input.subjectId ?? input.subjectKind,
        details: {
          policyId: input.policyId,
          policyVersion: input.policyVersion,
          stage: input.stage,
          actionTaken: input.actionTaken,
          subjectKind: input.subjectKind,
          subjectId: input.subjectId ?? null,
        },
      });
    } catch (error) {
      log.warn(
        { companyId: input.companyId, stage: input.stage, actionTaken: input.actionTaken },
        "failed to record guardrail violation",
      );
    }
  }

  /**
   * Finds the `guardrail_action` approval that matches a parked call.
   *
   * A parked call carries the tool name and a hash of its arguments. The
   * approval that a human resolved carries the same two values, so the pair
   * identifies the parked call unambiguously: approving one call does not
   * approve a different call of the same tool with different arguments.
   *
   * Rejected approvals are returned too, so the caller can cancel the parked
   * call instead of re-parking it forever. Pending approvals are returned as
   * well, so a retry of a call that is still waiting does not queue a second
   * approval for the human to answer.
   */
  async function findGuardrailApproval(input: {
    companyId: string;
    toolName: string;
    argumentsHash: string;
    agentId?: string | null;
    runId?: string | null;
    statuses: ReadonlyArray<"pending" | "approved" | "rejected">;
  }): Promise<{
    approvalId: string;
    status: "pending" | "approved" | "rejected";
    policyId: string | null;
    consumed: boolean;
  } | null> {
    const candidates = await db
      .select({
        id: approvals.id,
        status: approvals.status,
        payload: approvals.payload,
      })
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, input.companyId),
          eq(approvals.type, "guardrail_action"),
          inArray(approvals.status, input.statuses as string[]),
        ),
      )
      .orderBy(desc(approvals.createdAt))
      .then((rows) => rows);

    const matches: Array<{
      approvalId: string;
      status: "pending" | "approved" | "rejected";
      policyId: string | null;
      consumed: boolean;
    }> = [];

    for (const candidate of candidates) {
      const payload = candidate.payload ?? {};
      // The two enforcement paths name the tool differently in the payload
      // (`tool` on the gateway, `toolName` on the dispatcher), so both are
      // accepted rather than making one path's approvals unresolvable.
      const parkedTool = typeof payload.tool === "string"
        ? payload.tool
        : typeof payload.toolName === "string"
          ? payload.toolName
          : null;
      if (input.toolName && parkedTool !== input.toolName) continue;
      if (payload.argumentsHash !== input.argumentsHash) continue;
      if (input.agentId && typeof payload.agentId === "string" && payload.agentId !== input.agentId) {
        continue;
      }
      if (input.runId && typeof payload.runId === "string" && payload.runId !== input.runId) continue;
      matches.push({
        approvalId: candidate.id,
        status: candidate.status as "pending" | "approved" | "rejected",
        policyId: typeof payload.policyId === "string" ? payload.policyId : null,
        consumed: typeof payload.consumedAt === "string" && payload.consumedAt.length > 0,
      });
    }

    if (matches.length === 0) return null;

    // An approval a human gave but that has not been spent is the one that
    // releases the call, so it wins over any other row for the same call.
    const unspentApproval = matches.find(
      (match) => match.status === "approved" && !match.consumed,
    );
    if (unspentApproval) return unspentApproval;

    // Otherwise the most recent row carries the latest human decision.
    return matches[0]!;
  }

  /**
   * Marks an approval as used, so one human decision releases one call.
   *
   * The update is conditional on the approval still being unconsumed, so two
   * racing retries of the same call cannot both be released by a single
   * approval.
   */
  async function consumeGuardrailApproval(approvalId: string): Promise<boolean> {
    const now = new Date();
    const consumed = await db
      .update(approvals)
      .set({
        payload: sql`${approvals.payload} || ${JSON.stringify({ consumedAt: now.toISOString() })}::jsonb`,
        updatedAt: now,
      })
      .where(
        and(
          eq(approvals.id, approvalId),
          eq(approvals.status, "approved"),
          sql`(${approvals.payload} ->> 'consumedAt') is null`,
        ),
      )
      .returning({ id: approvals.id })
      .then((rows) => rows[0] ?? null);
    return Boolean(consumed);
  }

  /**
   * Applies the `input`-stage policies to a piece of free text.
   *
   * This is the entry point for the text-shaped enforcement points (the wake
   * payload, an agent-authored comment). It returns the text to use, which is
   * the redacted text when a `redact` policy matched and the original text
   * otherwise, plus the decision so the caller can react to a block.
   */  async function applyTextGuardrails(
    input: {
      companyId: string;
      text: string;
      agentId?: string | null;
      projectId?: string | null;
      goalId?: string | null;
      fields?: Record<string, string> | null;
    },
    options: {
      stage?: GuardrailPolicyStage;
      violation?: Partial<GuardrailViolationInput> & { subjectKind: GuardrailViolationSubjectKind };
    } = {},
  ): Promise<{ text: string; decision: GuardrailDecision }> {
    const decision = await applyGuardrails(
      {
        companyId: input.companyId,
        agentId: input.agentId,
        projectId: input.projectId,
        goalId: input.goalId,
        text: input.text,
        fields: input.fields,
      },
      {
        stage: options.stage ?? "input",
        violation: options.violation,
      },
    );
    return {
      text: decision.action === "redact" && decision.redactedText !== null ? decision.redactedText : input.text,
      decision,
    };
  }

  /**
   * Evaluates the `action`-stage policies against a tool call, before the tool
   * runs.
   *
   * Returns `null` when the call may proceed. A `block` throws a
   * `GuardrailBlockedError`; a `require_approval` parks the call on the
   * approvals queue and returns the parked result.
   *
   * Both the unified tool dispatcher and the tool gateway call this, so a
   * restricted-action policy means the same thing whichever path the tool
   * took to reach the agent.
   */
  async function enforceToolAction(input: {
    companyId: string;
    toolName: string;
    connectorType?: string | null;
    parameters: unknown;
    agentId?: string | null;
    runId?: string | null;
    projectId?: string | null;
    goalId?: string | null;
    /** Called when the policy demands approval, to park the call. */
    park: (parked: {
      approvalId: string | null;
      policyId: string | null;
      policyName: string;
      stage: GuardrailPolicyStage;
      toolName: string;
      connectorType: string | null;
      parameters: unknown;
      argumentsHash: string;
    }) => Promise<void> | void;
  }): Promise<
    | {
        outcome: "allow" | "require_approval";
        decision: GuardrailDecision;
        approvalId: string | null;
      }
    | {
        outcome: "cancelled";
        decision: GuardrailDecision;
        approvalId: string;
      }
    | {
        outcome: "block";
        decision: GuardrailDecision;
        approvalId: null;
      }
  > {
    const decision = await applyGuardrails(
      {
        companyId: input.companyId,
        agentId: input.agentId,
        projectId: input.projectId,
        goalId: input.goalId,
        text: typeof input.parameters === "string" ? input.parameters : null,
        fields: { tool_args: safeStringify(input.parameters) },
        toolName: input.toolName,
        connectorType: input.connectorType,
        toolArguments:
          typeof input.parameters === "object" &&
          input.parameters !== null &&
          !Array.isArray(input.parameters)
            ? (input.parameters as Record<string, unknown>)
            : null,
      },
      {
        stage: "action",
        violation: {
          subjectKind: "tool_action",
          actorAgentId: input.agentId,
          heartbeatRunId: input.runId,
        },
      },
    );

    if (decision.action === "allow" || decision.action === "redact") {
      return { outcome: "allow", decision, approvalId: null };
    }

    if (decision.action === "block") {
      return { outcome: "block", decision, approvalId: null };
    }

    // `require_approval`: the call is parked until a human resolves it.
    //
    // A human resolving the approval in the agent's favour is the signal that
    // this exact call may now proceed. The approval carries the tool name and
    // a hash of the arguments, so the resumed call is the one that was
    // reviewed — a different call with the same tool but different arguments
    // is still parked.
    const argumentsHash = hashToolValue(input.parameters ?? {});
    const resolved = await findGuardrailApproval({
      companyId: input.companyId,
      toolName: input.toolName,
      argumentsHash,
      agentId: input.agentId,
      runId: input.runId,
      statuses: ["approved", "rejected", "pending"],
    });

    if (resolved?.status === "approved" && !resolved.consumed) {
      // One approval releases one call. The consumption is conditional, so a
      // second retry of the same call finds the approval already spent.
      const consumed = await consumeGuardrailApproval(resolved.approvalId);
      if (consumed) {
        return { outcome: "allow", decision, approvalId: resolved.approvalId };
      }
    }

    if (resolved?.status === "rejected") {
      return { outcome: "cancelled", decision, approvalId: resolved.approvalId };
    }

    if (resolved?.status === "pending") {
      // The call is still waiting for a human. Parking it again would queue a
      // second approval for the same call, so the existing one is reported.
      return { outcome: "require_approval", decision, approvalId: resolved.approvalId };
    }

    const policyName = decision.decisive?.policyName ?? "unknown";
    const parked = {
      approvalId: null as string | null,
      policyId: decision.decisive?.policyId ?? null,
      policyName,
      stage: "action" as GuardrailPolicyStage,
      toolName: input.toolName,
      connectorType: input.connectorType ?? null,
      parameters: input.parameters,
      argumentsHash,
    };
    await input.park(parked);
    return { outcome: "require_approval", decision, approvalId: parked.approvalId };
  }

  /**
   * Applies the `input`-stage policies to the value a tool returned.
   *
   * A tool result is the highest-risk input in the studio — it comes from
   * outside — so it is checked before it reaches the agent.
   */
  async function enforceToolResult(input: {
    companyId: string;
    toolName: string;
    content: string;
    agentId?: string | null;
    runId?: string | null;
    projectId?: string | null;
    goalId?: string | null;
    park?: (parked: {
      approvalId: string | null;
      policyId: string | null;
      policyName: string;
      stage: GuardrailPolicyStage;
      toolName: string;
      argumentsHash: string;
    }) => Promise<void> | void;
  }): Promise<
    | { outcome: "allow" | "redact"; content: string; decision: GuardrailDecision }
    | { outcome: "require_approval"; content: string; decision: GuardrailDecision; approvalId: string | null }
    | { outcome: "cancelled"; content: string; decision: GuardrailDecision; approvalId: string }
    | { outcome: "block"; content: string; decision: GuardrailDecision }
  > {
    const decision = await applyGuardrails(
      {
        companyId: input.companyId,
        agentId: input.agentId,
        projectId: input.projectId,
        goalId: input.goalId,
        text: input.content,
        fields: { tool_result: input.content },
        toolName: input.toolName,
      },
      {
        stage: "input",
        violation: {
          subjectKind: "tool_result",
          actorAgentId: input.agentId,
          heartbeatRunId: input.runId,
        },
      },
    );

    if (decision.action === "allow") {
      return { outcome: "allow", content: input.content, decision };
    }
    if (decision.action === "redact") {
      return { outcome: "redact", content: decision.redactedText ?? input.content, decision };
    }
    if (decision.action === "require_approval") {
      // A human resolving the approval in the agent's favour releases this
      // exact result. The approval carries the tool name and a hash of the
      // result, so a different result of the same tool is still withheld.
      const contentHash = hashToolValue(input.content);
      const resolved = await findGuardrailApproval({
        companyId: input.companyId,
        toolName: input.toolName,
        argumentsHash: contentHash,
        agentId: input.agentId,
        runId: input.runId,
        statuses: ["approved", "rejected", "pending"],
      });

      if (resolved?.status === "approved" && !resolved.consumed) {
        // One approval releases one result. The consumption is conditional, so
        // a second read of the same result finds the approval already spent.
        const consumed = await consumeGuardrailApproval(resolved.approvalId);
        if (consumed) {
          return { outcome: "allow", content: input.content, decision };
        }
      }

      if (resolved?.status === "rejected") {
        return { outcome: "cancelled", content: input.content, decision, approvalId: resolved.approvalId };
      }

      if (resolved?.status === "pending") {
        return {
          outcome: "require_approval",
          content: input.content,
          decision,
          approvalId: resolved.approvalId,
        };
      }

      if (input.park) {
        const parked = {
          approvalId: null as string | null,
          policyId: decision.decisive?.policyId ?? null,
          policyName: decision.decisive?.policyName ?? "unknown",
          stage: "input" as GuardrailPolicyStage,
          toolName: input.toolName,
          argumentsHash: contentHash,
        };
        await input.park(parked);
      }
      // The call is still waiting for a human. A caller with no `park`
      // callback cannot queue an approval, so the result is withheld rather
      // than released.
      return { outcome: "require_approval", content: input.content, decision, approvalId: null };
    }
    // `block` is the only action left here: `allow` and `redact` returned
    // above, and `require_approval` either released, was rejected, or parked.
    return { outcome: "block", content: input.content, decision };
  }

  return {
    applyGuardrails,
    applyTextGuardrails,
    enforceToolAction,
    enforceToolResult,
    recordViolation,
    findGuardrailApproval,
    consumeGuardrailApproval,
    resolveEffectivePolicies: (input: Parameters<typeof resolveEffectivePolicies>[1]) =>
      resolveEffectivePolicies(db, input),
    evaluatePolicy,

    listPolicies: (companyId: string) =>
      db
        .select()
        .from(guardrailPolicies)
        .where(eq(guardrailPolicies.companyId, companyId))
        .orderBy(asc(guardrailPolicies.createdAt)),

    getPolicy: (companyId: string, policyId: string) =>
      db
        .select()
        .from(guardrailPolicies)
        .where(and(eq(guardrailPolicies.companyId, companyId), eq(guardrailPolicies.id, policyId)))
        .then((rows) => rows[0] ?? null),

    createPolicy: (
      companyId: string,
      data: Omit<typeof guardrailPolicies.$inferInsert, "companyId">,
    ) =>
      db
        .insert(guardrailPolicies)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]!),

    updatePolicy: (
      companyId: string,
      policyId: string,
      data: Partial<typeof guardrailPolicies.$inferInsert>,
    ) =>
      db
        .update(guardrailPolicies)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(guardrailPolicies.companyId, companyId), eq(guardrailPolicies.id, policyId)))
        .returning()
        .then((rows) => rows[0] ?? null),

    deletePolicy: (companyId: string, policyId: string) =>
      db
        .delete(guardrailPolicies)
        .where(and(eq(guardrailPolicies.companyId, companyId), eq(guardrailPolicies.id, policyId)))
        .returning()
        .then((rows) => rows[0] ?? null),

    listViolations: (
      companyId: string,
      filter: {
        policyId?: string;
        stage?: GuardrailPolicyStage;
        agentId?: string;
        runId?: string;
        action?: GuardrailPolicyAction;
        resolved?: boolean;
        since?: Date;
        until?: Date;
        limit?: number;
        offset?: number;
      } = {},
    ) => {
      const conditions = [eq(guardrailViolations.companyId, companyId)];
      if (filter.policyId) conditions.push(eq(guardrailViolations.policyId, filter.policyId));
      if (filter.stage) conditions.push(eq(guardrailViolations.stage, filter.stage));
      if (filter.agentId) conditions.push(eq(guardrailViolations.actorAgentId, filter.agentId));
      if (filter.runId) conditions.push(eq(guardrailViolations.heartbeatRunId, filter.runId));
      if (filter.action) conditions.push(eq(guardrailViolations.actionTaken, filter.action));
      if (filter.resolved !== undefined) {
        conditions.push(eq(guardrailViolations.resolved, filter.resolved));
      }
      if (filter.since) conditions.push(gte(guardrailViolations.createdAt, filter.since));
      if (filter.until) conditions.push(lte(guardrailViolations.createdAt, filter.until));

      return db
        .select()
        .from(guardrailViolations)
        .where(and(...conditions))
        .orderBy(desc(guardrailViolations.createdAt))
        .limit(filter.limit ?? 100)
        .offset(filter.offset ?? 0);
    },

    countViolations: async (
      companyId: string,
      filter: { stage?: GuardrailPolicyStage; action?: GuardrailPolicyAction } = {},
    ) => {
      const conditions = [eq(guardrailViolations.companyId, companyId)];
      if (filter.stage) conditions.push(eq(guardrailViolations.stage, filter.stage));
      if (filter.action) conditions.push(eq(guardrailViolations.actionTaken, filter.action));
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(guardrailViolations)
        .where(and(...conditions));
      return row?.count ?? 0;
    },

    resolveViolation: (companyId: string, violationId: string) =>
      db
        .update(guardrailViolations)
        .set({ resolved: true, updatedAt: new Date() })
        .where(and(eq(guardrailViolations.companyId, companyId), eq(guardrailViolations.id, violationId)))
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}

export type GuardrailService = ReturnType<typeof guardrailService>;
