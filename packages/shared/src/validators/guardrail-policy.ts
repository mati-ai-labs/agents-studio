import { z } from "zod";
import {
  GUARDRAIL_POLICY_ACTIONS,
  GUARDRAIL_POLICY_KINDS,
  GUARDRAIL_POLICY_SCOPE_TYPES,
  GUARDRAIL_POLICY_SEVERITIES,
  GUARDRAIL_POLICY_STAGES,
} from "../constants.js";
import { multilineTextSchema } from "./text.js";

/**
 * Fields a policy matcher can restrict matching to. A matcher without `fields`
 * applies to every field of the subject it is evaluated against.
 */
export const GUARDRAIL_MATCHER_FIELDS = [
  "any",
  "comment",
  "description",
  "title",
  "document_body",
  "tool_result",
  "tool_args",
  "tool_name",
] as const;
export type GuardrailMatcherField = (typeof GUARDRAIL_MATCHER_FIELDS)[number];

export const guardrailMatcherFieldSchema = z.enum(GUARDRAIL_MATCHER_FIELDS);

/**
 * Base matcher shape shared by every policy kind. `patterns` are regular
 * expressions; `fields` restricts which part of the subject they apply to.
 */
const guardrailMatcherBase = z.object({
  patterns: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
  fields: z.array(guardrailMatcherFieldSchema).max(20).optional(),
});

/**
 * `pii` — matches personal data (email, phone, and the PII families the
 * studio's own redaction helpers recognise).
 */
export const guardrailPiiMatcherSchema = guardrailMatcherBase.extend({
  kind: z.literal("pii"),
  piiTypes: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
});

/**
 * `secret` — matches credentials and tokens.
 */
export const guardrailSecretMatcherSchema = guardrailMatcherBase.extend({
  kind: z.literal("secret"),
  secretTypes: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
});

/**
 * `restricted_action` — matches a tool call by tool name, connector type, or
 * argument shape.
 *
 * The base shape is kept separate from the refined schema because a zod
 * discriminated union needs plain objects as its members.
 */
const guardrailRestrictedActionMatcherBase = z.object({
  kind: z.literal("restricted_action"),
  toolNames: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  connectorTypes: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  argumentPatterns: z
    .array(
      z.object({
        path: z.string().trim().min(1).max(200),
        pattern: z.string().trim().min(1).max(500),
      }),
    )
    .max(20)
    .optional(),
  fields: z.array(guardrailMatcherFieldSchema).max(20).optional(),
});

export const guardrailRestrictedActionMatcherSchema = guardrailRestrictedActionMatcherBase.refine(
  (value) =>
    (value.toolNames?.length ?? 0) > 0 ||
    (value.connectorTypes?.length ?? 0) > 0 ||
    (value.argumentPatterns?.length ?? 0) > 0,
  { message: "restricted_action matcher needs at least one of toolNames, connectorTypes or argumentPatterns" },
);

/**
 * `regex` — matches arbitrary patterns supplied by the policy author.
 */
export const guardrailRegexMatcherSchema = z.object({
  kind: z.literal("regex"),
  patterns: z.array(z.string().trim().min(1).max(500)).min(1).max(50),
  fields: z.array(guardrailMatcherFieldSchema).max(20).optional(),
});

/**
 * `allowlist` — inverts the decision: only the listed values are permitted, so
 * anything else matches the policy.
 */
export const guardrailAllowlistMatcherSchema = z.object({
  kind: z.literal("allowlist"),
  values: z.array(z.string().trim().min(1).max(500)).min(1).max(200),
  fields: z.array(guardrailMatcherFieldSchema).max(20).optional(),
});

/**
 * The matcher payload, discriminated by `kind`. The stored `matcher` jsonb
 * carries its own `kind` so a matcher is self-describing when read back.
 */
export const guardrailMatcherSchema = z.discriminatedUnion("kind", [
  guardrailPiiMatcherSchema,
  guardrailSecretMatcherSchema,
  guardrailRestrictedActionMatcherBase,
  guardrailRegexMatcherSchema,
  guardrailAllowlistMatcherSchema,
]);

export type GuardrailMatcher = z.infer<typeof guardrailMatcherSchema>;

/** Matcher schema for a given policy kind. */
export function guardrailMatcherSchemaForKind(kind: (typeof GUARDRAIL_POLICY_KINDS)[number]) {
  switch (kind) {
    case "pii":
      return guardrailPiiMatcherSchema;
    case "secret":
      return guardrailSecretMatcherSchema;
    case "restricted_action":
      return guardrailRestrictedActionMatcherSchema;
    case "regex":
      return guardrailRegexMatcherSchema;
    case "allowlist":
      return guardrailAllowlistMatcherSchema;
  }
}

/**
 * The policy body shared by the API and the studio UI. The UI validates
 * against this same contract, so a policy can never be authored in a shape
 * the server would reject.
 */
export const guardrailPolicyBodySchema = z.object({
  scopeType: z.enum(GUARDRAIL_POLICY_SCOPE_TYPES),
  scopeId: z.string().uuid().nullable().optional(),
  stage: z.enum(GUARDRAIL_POLICY_STAGES),
  name: z.string().trim().min(1).max(160),
  kind: z.enum(GUARDRAIL_POLICY_KINDS),
  matcher: guardrailMatcherSchema.optional().nullable(),
  action: z.enum(GUARDRAIL_POLICY_ACTIONS),
  severity: z.enum(GUARDRAIL_POLICY_SEVERITIES),
  enabled: z.boolean().optional().default(true),
  description: multilineTextSchema.optional().nullable(),
});

export type GuardrailPolicyBody = z.infer<typeof guardrailPolicyBodySchema>;

/**
 * Checks that a matcher is shaped for the policy kind it belongs to, and that
 * the matcher's own discriminator agrees with the policy kind.
 */
export function checkGuardrailMatcherForKind(
  kind: (typeof GUARDRAIL_POLICY_KINDS)[number],
  matcher: unknown,
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void {
  if (matcher === null || matcher === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `matcher is required for a '${kind}' policy`,
      path,
    });
    return;
  }
  const schema = guardrailMatcherSchemaForKind(kind);
  const parsed = schema.safeParse(matcher);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: issue.message,
        path: [...path, ...issue.path],
      });
    }
    return;
  }
  if (parsed.data.kind !== kind) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `matcher kind '${parsed.data.kind}' does not match policy kind '${kind}'`,
      path: [...path, "kind"],
    });
  }
}

export const createGuardrailPolicySchema = guardrailPolicyBodySchema.superRefine((value, ctx) => {
  if (value.scopeType === "company" && value.scopeId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "scopeId must be omitted for company-scoped policies",
      path: ["scopeId"],
    });
  }
  if (value.scopeType !== "company" && !value.scopeId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "scopeId is required for agent, project and goal-scoped policies",
      path: ["scopeId"],
    });
  }
  if (value.action === "allow") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A policy with action 'allow' never fires; use 'redact', 'block' or 'require_approval'",
      path: ["action"],
    });
  }
  checkGuardrailMatcherForKind(value.kind, value.matcher, ctx, ["matcher"]);
});

export type CreateGuardrailPolicy = z.infer<typeof createGuardrailPolicySchema>;

export const updateGuardrailPolicySchema = guardrailPolicyBodySchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required",
  })
  .superRefine((value, ctx) => {
    if (value.kind) {
      checkGuardrailMatcherForKind(value.kind, value.matcher, ctx, ["matcher"]);
    }
  });

export type UpdateGuardrailPolicy = z.infer<typeof updateGuardrailPolicySchema>;

/**
 * Simulation request: a sample subject plus the candidate policies to
 * evaluate against it. The studio UI calls this before a policy is saved.
 */
export const simulateGuardrailPoliciesSchema = z.object({
  stage: z.enum(GUARDRAIL_POLICY_STAGES),
  subject: z.string().optional().nullable(),
  subjectFields: z.record(z.string(), z.string()).optional().nullable(),
  toolName: z.string().trim().min(1).max(200).optional().nullable(),
  connectorType: z.string().trim().min(1).max(100).optional().nullable(),
  toolArguments: z.record(z.string(), z.unknown()).optional().nullable(),
  candidatePolicy: guardrailPolicyBodySchema.optional().nullable(),
  policyIds: z.array(z.string().uuid()).max(100).optional().nullable(),
  agentId: z.string().uuid().optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
});

export type SimulateGuardrailPolicies = z.infer<typeof simulateGuardrailPoliciesSchema>;

export const guardrailViolationsQuerySchema = z.object({
  policyId: z.string().uuid().optional(),
  stage: z.enum(GUARDRAIL_POLICY_STAGES).optional(),
  agentId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
  action: z.enum(GUARDRAIL_POLICY_ACTIONS).optional(),
  resolved: z.enum(["true", "false"]).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export type GuardrailViolationsQuery = z.infer<typeof guardrailViolationsQuerySchema>;
