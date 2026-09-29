import type { Request, RequestHandler } from "express";
import { forbidden } from "../errors.js";

/**
 * Enforces the `restricted_operator` instance role for board users.
 *
 * Company scoping and the company-creation block come from the actor itself
 * (`companyIds` = active memberships, `isInstanceAdmin` forced false). This
 * guard covers the rest: prompts/instructions and skills are hidden, and
 * company import/export (which would expose both) is denied.
 */

const BLOCKED_PATHS: RegExp[] = [
  /^\/skills(\/|$)/,
  /^\/companies\/[^/]+\/(skills|skill-policy|skill-test-run-templates)(\/|$)/,
  /^\/agents\/[^/]+\/(skills|instructions-path|instructions-bundle)(\/|$)/,
  /^\/companies\/[^/]+\/(export|exports)(\/|$)/,
  /^\/companies\/import(\/|$)/,
  // Routine revisions and description annotations both carry the routine prompt.
  /^\/routines\/[^/]+\/(revisions|description)(\/|$)/,
  /^\/routine-triggers\/[^/]+\/rotate-secret$/,
  // Run transcripts and logs: restricted operators only get the run summary.
  /^\/heartbeat-runs\/[^/]+\/(events|log|workspace-operations)(\/|$)/,
  /^\/workspace-operations\/[^/]+\/log$/,
  // Company settings: connectors and secret providers are fully off-limits.
  /^\/connectors(\/|$)/,
  /^\/agents\/[^/]+\/connector-credentials(\/|$)/,
  /^\/(companies\/[^/]+\/)?secret-provider-configs(\/|$)/,
  /^\/companies\/[^/]+\/secret-providers(\/|$)/,
];

/** Run fields that carry raw output or the wake prompt. */
const RESTRICTED_RUN_KEYS = ["stdoutExcerpt", "stderrExcerpt", "contextSnapshot"] as const;

/** Mutations restricted operators may never perform, keyed by method. */
const BLOCKED_MUTATIONS: Array<{ method: string; pattern: RegExp; message: string }> = [
  { method: "POST", pattern: /^\/companies\/[^/]+\/routines$/, message: "Restricted users cannot create routines" },
  { method: "POST", pattern: /^\/routines\/[^/]+\/triggers$/, message: "Restricted users cannot manage routine triggers" },
  { method: "PATCH", pattern: /^\/routine-triggers\/[^/]+$/, message: "Restricted users cannot manage routine triggers" },
  { method: "DELETE", pattern: /^\/routine-triggers\/[^/]+$/, message: "Restricted users cannot manage routine triggers" },
  // Access is view-only: no editing anyone's role, grants, or membership.
  ...["PUT", "PATCH", "DELETE"].map((method) => ({
    method,
    pattern: /^\/companies\/[^/]+\/members\/[^/]+(\/|$)/,
    message: "Restricted users cannot change member access",
  })),
  { method: "POST", pattern: /^\/companies\/[^/]+\/members\/[^/]+\/archive$/, message: "Restricted users cannot change member access" },
  // Agent (OpenClaw) invites allow custom join payloads; restricted invites are human-only.
  { method: "POST", pattern: /^\/companies\/[^/]+\/openclaw\/invite-prompt$/, message: "Restricted users cannot create agent invites" },
  // Secrets and environments stay readable for pickers, but cannot be changed.
  ...["POST", "PUT", "PATCH", "DELETE"].flatMap((method) => [
    { method, pattern: /^\/companies\/[^/]+\/secrets$/, message: "Restricted users cannot manage secrets" },
    { method, pattern: /^\/secrets\/[^/]+(\/|$)/, message: "Restricted users cannot manage secrets" },
    { method, pattern: /^\/companies\/[^/]+\/environments$/, message: "Restricted users cannot manage environments" },
    { method, pattern: /^\/environments\/[^/]+(\/|$)/, message: "Restricted users cannot manage environments" },
  ]),
];

const ROUTINE_PATHS: RegExp[] = [
  /^\/companies\/[^/]+\/routines(\/|$)/,
  /^\/routines(\/|$)/,
  /^\/routine-triggers(\/|$)/,
];

/** Routine fields holding the prompt or webhook material. Triggers are emptied separately. */
const RESTRICTED_ROUTINE_KEYS = ["description", "descriptionDocument", "triggerPayload", "publicId", "secretId"] as const;

/** adapterConfig keys that carry prompts, instructions, or skill selections. */
export const RESTRICTED_ADAPTER_CONFIG_KEYS = [
  "promptTemplate",
  "bootstrapPromptTemplate",
  "instructions",
  "instructionsFilePath",
  "instructionsRootPath",
  "instructionsEntryFile",
  "instructionsBundleMode",
  "paperclipSkillSync",
] as const;

/** Top-level agent create/update body fields that set prompts or skills. */
const RESTRICTED_AGENT_BODY_KEYS = ["instructionsBundle", "desiredSkills"] as const;

const AGENT_MUTATION_PATHS: RegExp[] = [
  /^\/agents\/[^/]+$/,
  /^\/companies\/[^/]+\/(agents|agent-hires)$/,
];

export function isRestrictedBoardActor(req: Request): boolean {
  return req.actor?.type === "board" && req.actor.isRestricted === true;
}

/** Only literal objects; Dates, Buffers, and class instances pass through untouched. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function stripAdapterConfig(config: Record<string, unknown>): Record<string, unknown> {
  const next = { ...config };
  for (const key of RESTRICTED_ADAPTER_CONFIG_KEYS) delete next[key];
  return next;
}

/** Deep-copies a JSON payload, removing prompt/skill keys from every `adapterConfig`. */
export function redactRestrictedPayload(value: unknown, depth = 0): unknown {
  if (depth > 32) return value;
  if (Array.isArray(value)) return value.map((item) => redactRestrictedPayload(item, depth + 1));
  if (!isPlainObject(value)) return value;
  // Issues materialized by a routine carry the routine prompt as their body.
  const isRoutineExecution = value.originKind === "routine_execution";
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isRoutineExecution && key === "description") continue;
    if ((RESTRICTED_RUN_KEYS as readonly string[]).includes(key)) continue;
    if (key === "adapterConfig" && isPlainObject(child)) {
      out[key] = redactRestrictedPayload(stripAdapterConfig(child), depth + 1);
    } else {
      out[key] = redactRestrictedPayload(child, depth + 1);
    }
  }
  return out;
}

/**
 * Deep-copies a routine payload, dropping prompt fields and webhook triggers.
 * Applied only to routine endpoints, where `description` is the routine prompt.
 */
export function redactRoutinePayload(value: unknown, depth = 0): unknown {
  if (depth > 32) return value;
  if (Array.isArray(value)) return value.map((item) => redactRoutinePayload(item, depth + 1));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if ((RESTRICTED_ROUTINE_KEYS as readonly string[]).includes(key)) continue;
    if (key === "triggers" && Array.isArray(child)) {
      // Restricted operators see no triggers at all; keep the array shape for the UI.
      out[key] = [];
      continue;
    }
    out[key] = redactRoutinePayload(child, depth + 1);
  }
  return out;
}

export function restrictedOperatorGuard(): RequestHandler {
  return (req, res, next) => {
    if (!isRestrictedBoardActor(req)) {
      next();
      return;
    }

    const path = req.path;
    if (BLOCKED_PATHS.some((pattern) => pattern.test(path))) {
      next(forbidden("Restricted users cannot access prompts or skills"));
      return;
    }

    const method = req.method.toUpperCase();
    const blockedMutation = BLOCKED_MUTATIONS.find(
      (rule) => rule.method === method && rule.pattern.test(path),
    );
    if (blockedMutation) {
      next(forbidden(blockedMutation.message));
      return;
    }
    if (
      (method === "POST" || method === "PATCH" || method === "PUT")
      && AGENT_MUTATION_PATHS.some((pattern) => pattern.test(path))
      && isPlainObject(req.body)
    ) {
      if (req.body.replaceAdapterConfig === true) {
        // A full replace would silently drop the prompts this user cannot see.
        next(forbidden("Restricted users cannot replace agent adapter configuration"));
        return;
      }
      const body = { ...req.body };
      for (const key of RESTRICTED_AGENT_BODY_KEYS) delete body[key];
      if (isPlainObject(body.adapterConfig)) body.adapterConfig = stripAdapterConfig(body.adapterConfig);
      req.body = body;
    }

    if (method === "PATCH" && /^\/companies\/[^/]+$/.test(path) && isPlainObject(req.body)) {
      // The hiring-approval policy is hidden from restricted operators.
      const body = { ...req.body };
      delete body.requireBoardApprovalForNewAgents;
      req.body = body;
    }

    const isRoutinePath = ROUTINE_PATHS.some((pattern) => pattern.test(path));
    if (isRoutinePath && isPlainObject(req.body)) {
      if (method === "PATCH" && /^\/routines\/[^/]+$/.test(path)) {
        // Never let a hidden routine prompt be overwritten.
        const body = { ...req.body };
        delete body.description;
        req.body = body;
      }
    }

    const json = res.json.bind(res);
    res.json = (payload: unknown) => {
      const redacted = redactRestrictedPayload(payload);
      return json(isRoutinePath ? redactRoutinePayload(redacted) : redacted);
    };
    next();
  };
}
