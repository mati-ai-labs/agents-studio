import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Agent-side guardrail hook for Claude Code.
 *
 * SessionStart: fetches the company's plain-English guardrail rules and adds
 * them to the agent's context, so it plans within them.
 * PreToolUse: sends every non-read-only action to the studio for review
 * (deterministic policies + classifier) before it runs. A denial comes back as
 * `permissionDecision: "deny"` with a reason the model reads and re-plans
 * around, the same way Claude Code's auto-mode classifier blocks commands.
 *
 * If the studio cannot be reached the hook allows the action (fail open), so
 * a server restart never freezes every agent.
 */
export const GUARDRAIL_HOOK_SCRIPT = String.raw`#!/usr/bin/env node
const READ_ONLY = new Set(["Read","Glob","Grep","LS","NotebookRead","TodoWrite","TaskCreate","TaskUpdate","TaskList","TaskGet","TaskOutput","ToolSearch","WebSearch","WebFetch","ListMcpResourcesTool","ReadMcpResourceTool","BashOutput"]);
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", async () => {
  let input = {};
  try { input = JSON.parse(raw || "{}"); } catch {}
  const base = String(process.env.PAPERCLIP_API_URL || "").replace(/\/+$/, "").replace(/\/api$/, "");
  const key = process.env.PAPERCLIP_API_KEY;
  if (!base || !key) process.exit(0);
  const headers = { authorization: "Bearer " + key, "content-type": "application/json" };
  if (process.env.PAPERCLIP_RUN_ID) headers["x-paperclip-run-id"] = process.env.PAPERCLIP_RUN_ID;
  try {
    if (input.hook_event_name === "SessionStart") {
      const res = await fetch(base + "/api/guardrails/agent-context", { headers, signal: AbortSignal.timeout(10000) });
      const body = res.ok ? await res.json() : {};
      if (body && body.context) {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: body.context } }));
      }
      process.exit(0);
    }
    if (input.hook_event_name === "PreToolUse") {
      if (READ_ONLY.has(input.tool_name)) process.exit(0);
      const res = await fetch(base + "/api/guardrails/review-action", {
        method: "POST",
        headers,
        body: JSON.stringify({ toolName: input.tool_name, toolInput: input.tool_input }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) process.exit(0);
      const body = await res.json();
      if (body && (body.decision === "deny" || body.decision === "approval")) {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: body.reason || "Blocked by a board guardrail." } }));
      }
      process.exit(0);
    }
  } catch {
    process.exit(0);
  }
  process.exit(0);
});
`;

export function buildGuardrailHookSettings(scriptPath: string, nodePath = process.execPath) {
  const command = JSON.stringify(nodePath) + " " + JSON.stringify(scriptPath);
  return {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command, timeout: 15 }] }],
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command, timeout: 40 }] }],
    },
  };
}

/** Writes the hook script and a settings file for one run; returns the settings path for `--settings`. */
export async function prepareGuardrailHook(runId: string): Promise<string> {
  const dir = path.join(os.tmpdir(), "paperclip-guardrail-hook", runId.replace(/[^A-Za-z0-9_-]/g, "_"));
  await fs.mkdir(dir, { recursive: true });
  const scriptPath = path.join(dir, "guardrail-hook.mjs");
  await fs.writeFile(scriptPath, GUARDRAIL_HOOK_SCRIPT, { encoding: "utf8", mode: 0o755 });
  const settingsPath = path.join(dir, "settings.json");
  await fs.writeFile(settingsPath, JSON.stringify(buildGuardrailHookSettings(scriptPath), null, 2), "utf8");
  return settingsPath;
}
