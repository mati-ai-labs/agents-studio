import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { agents, approvals, companies, createDb, guardrailPolicies, guardrailViolations } from "@paperclipai/db";
import { GUARDRAIL_HOOK_SCRIPT } from "@paperclipai/adapter-claude-local/server";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  actionFingerprint,
  guardrailActionReviewService,
  isReadOnlyAction,
  setGuardrailClassifierForTests,
  type ClassifierCall,
} from "../services/guardrail-action-review.js";
import { guardrailReviewRoutes } from "../routes/guardrail-review.js";
import { errorHandler } from "../middleware/index.js";

describe("actionFingerprint", () => {
  it("ignores Claude Code's non-semantic fields and whitespace, but not the command", () => {
    const a = actionFingerprint("Bash", { command: "curl -X POST $API/x  -d '{}'", description: "Create it" });
    const b = actionFingerprint("Bash", { command: "curl -X POST $API/x -d '{}'", description: "Create the sub-issue", timeout: 30000 });
    const c = actionFingerprint("Bash", { command: "curl -X POST $API/y -d '{}'" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("ties a script-running command to the script's contents", () => {
    const run = (content: string) =>
      actionFingerprint("Bash", { command: "bash ./x.sh", scriptContents: [{ path: "/w/x.sh", content }] });
    expect(run("echo hi")).toBe(run("echo   hi"));
    expect(run("echo hi")).not.toBe(run("curl -X PATCH $API/agents/a1 -d '{}'"));
    expect(run("echo hi")).not.toBe(actionFingerprint("Bash", { command: "bash ./x.sh" }));
  });

  it("does not depend on (or store) the credential typed into a command", () => {
    const withKey = actionFingerprint("Bash", { command: "curl -X POST $API/x -H 'Authorization: Bearer pcp_cd6d59e6921167a4da7ddb9d091c7520f60122e5446998b9'" });
    const otherKey = actionFingerprint("Bash", { command: "curl -X POST $API/x -H 'Authorization: Bearer pcp_0000000000000000000000000000000000000000000000'" });
    expect(withKey).toBe(otherKey);
  });
});

describe("isReadOnlyAction", () => {
  it("skips reads and read-only shell commands", () => {
    expect(isReadOnlyAction("Read", { file_path: "/x" })).toBe(true);
    expect(isReadOnlyAction("Bash", { command: "git status && git log -3" })).toBe(true);
    expect(isReadOnlyAction("Bash", { command: "curl -s $API/api/issues/1 | jq .title" })).toBe(true);
    expect(isReadOnlyAction("Bash", { command: "cd repo && ls -la" })).toBe(true);
  });
  it("reviews anything that can change state", () => {
    expect(isReadOnlyAction("Bash", { command: "curl -s -X POST $API/api/companies/c/issues -d '{}'" })).toBe(false);
    expect(isReadOnlyAction("Bash", { command: "curl -s $API/x --data '{\"a\":1}'" })).toBe(false);
    expect(isReadOnlyAction("Bash", { command: "gh pr merge 48 --squash" })).toBe(false);
    // paperclip:allow-git-push: guardrail test input describing an agent action; nothing is pushed
    expect(isReadOnlyAction("Bash", { command: "git push origin main" })).toBe(false);
    expect(isReadOnlyAction("Bash", { command: "echo hi > file.txt" })).toBe(false);
    expect(isReadOnlyAction("Bash", { command: "npm test" })).toBe(false);
    expect(isReadOnlyAction("Edit", { file_path: "/x" })).toBe(false);
    expect(isReadOnlyAction("mcp__github__create_pull_request", {})).toBe(false);
    expect(isReadOnlyAction("Bash", { command: "cat notes.txt", scriptContents: [{ path: "/w/x.sh", content: "rm -rf /" }] })).toBe(false);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("guardrail action review", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let agentId = "";
  const calls: ClassifierCall[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-action-review-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    calls.length = 0;
    setGuardrailClassifierForTests(null);
    await db.execute(sql.raw(`TRUNCATE TABLE "guardrail_violations", "guardrail_policies", "approvals", "activity_log", "agents", "companies" RESTART IDENTITY CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Review Co", issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "CTO", role: "cto", adapterType: "process", adapterConfig: {}, status: "idle" });
  }

  async function rule(name: string, text: string, action: "block" | "require_approval") {
    const [row] = await db.insert(guardrailPolicies).values({
      companyId, scopeType: "company", scopeId: null, stage: "action", name, kind: "rule",
      matcher: { kind: "rule", rule: text }, action, severity: "high", enabled: true, version: 1,
    }).returning();
    return row!;
  }

  // Stand-in for the classifier model: flags sub-issue creation and model changes.
  function fakeClassifier() {
    setGuardrailClassifierForTests(async (call) => {
      calls.push(call);
      const text = JSON.stringify(call.toolInput);
      const byName = (needle: string) => call.rules.find((entry) => entry.rule.includes(needle))?.id ?? null;
      if (text.includes("parentId")) return { decision: "approval", ruleId: byName("sub-issues"), reason: "Creating a sub-issue." };
      if (text.includes("claude-sonnet")) return { decision: "deny", ruleId: byName("model"), reason: "This changes another agent's model." };
      return { decision: "allow", ruleId: null, reason: "" };
    });
  }

  const review = () => guardrailActionReviewService(db);
  const bash = (command: string) => ({ toolName: "Bash", toolInput: { command } });

  it("allows everything without calling the classifier when there are no rules", async () => {
    await seed();
    fakeClassifier();
    const result = await review().reviewAction({ companyId, agentId, runId: null, ...bash("gh pr merge 48") });
    expect(result).toMatchObject({ decision: "allow", source: "no_rules" });
    expect(calls).toHaveLength(0);
  });

  it("never sends read-only actions to the classifier", async () => {
    await seed();
    await rule("No sub-issues", "Do not create sub-issues without approval", "require_approval");
    fakeClassifier();
    expect(await review().reviewAction({ companyId, agentId, runId: null, ...bash("git status") })).toMatchObject({ decision: "allow", source: "read_only" });
    expect(calls).toHaveLength(0);
  });

  it("denies an action that breaks a block rule, with a reason the agent reads", async () => {
    await seed();
    await rule("Models are mine", "Never change another agent's model or effort", "block");
    fakeClassifier();
    const result = await review().reviewAction({ companyId, agentId, runId: null, ...bash(`curl -X PATCH $API/api/agents/x -d '{"adapterConfig":{"model":"claude-sonnet-4-6"}}'`) });
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("Models are mine");
    expect(result.reason).toContain("another agent's model");
    expect(calls[0]!.rules.map((entry) => entry.name)).toEqual(["Models are mine"]);
    expect(await db.select().from(guardrailViolations)).toHaveLength(1);
  });

  it("holds a require_approval action, keeps holding retries, then allows exactly that action once after approval", async () => {
    await seed();
    await rule("No sub-issues", "Do not create sub-issues without approval", "require_approval");
    fakeClassifier();
    const action = bash(`curl -X POST $API/api/companies/c/issues -d '{"title":"t","parentId":"p"}'`);

    const first = await review().reviewAction({ companyId, agentId, runId: null, ...action });
    expect(first.decision).toBe("approval");
    expect(first.reason).toContain("Stop this line of work");
    const [approval] = await db.select().from(approvals);
    expect(approval).toMatchObject({ type: "guardrail_action", status: "pending", requestedByAgentId: agentId });

    const retry = await review().reviewAction({ companyId, agentId, runId: null, ...action });
    expect(retry.decision).toBe("deny");
    expect(retry.reason).toContain("waiting for board approval");
    expect(await db.select().from(approvals)).toHaveLength(1);

    await db.update(approvals).set({ status: "approved" });
    expect(await review().reviewAction({ companyId, agentId, runId: null, ...action })).toMatchObject({ decision: "allow", source: "approved" });
    // Spent: the next identical action is reviewed again.
    expect((await review().reviewAction({ companyId, agentId, runId: null, ...action })).decision).not.toBe("allow");
  });

  it("puts the rules into the agent's session context", async () => {
    await seed();
    await rule("No sub-issues", "Do not create sub-issues without approval", "require_approval");
    await rule("Models are mine", "Never change another agent's model or effort", "block");
    const context = await review().agentRulesContext(companyId, agentId);
    expect(context).toContain("BOARD GUARDRAILS");
    expect(context).toContain("Do not create sub-issues without approval (needs board approval)");
    expect(context).toContain("Never change another agent's model or effort");
  });

  it("fails open if the classifier errors", async () => {
    await seed();
    await rule("Models are mine", "Never change another agent's model or effort", "block");
    setGuardrailClassifierForTests(async () => {
      throw new Error("provider down");
    });
    // paperclip:allow-git-push: guardrail test input describing an agent action; nothing is pushed
    expect(await review().reviewAction({ companyId, agentId, runId: null, ...bash("git push origin x") })).toMatchObject({ decision: "allow", source: "error" });
  });

  it("the real hook script turns a denial into a Claude Code PreToolUse deny, and injects rules at SessionStart", async () => {
    await seed();
    await rule("Models are mine", "Never change another agent's model or effort", "block");
    fakeClassifier();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = { type: "agent", agentId, companyId, source: "agent_key" };
      next();
    });
    app.use("/api", guardrailReviewRoutes(db));
    app.use(errorHandler);
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const dir = await mkdtemp(path.join(os.tmpdir(), "guardrail-hook-"));
    const script = path.join(dir, "hook.mjs");
    await writeFile(script, GUARDRAIL_HOOK_SCRIPT);
    const runHook = (payload: unknown) =>
      new Promise<string>((resolve, reject) => {
        const child = execFile(process.execPath, [script], {
          env: { ...process.env, PAPERCLIP_API_URL: `http://127.0.0.1:${port}/api`, PAPERCLIP_API_KEY: "k" },
        }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
        child.stdin!.end(JSON.stringify(payload));
      });
    try {
      const denied = JSON.parse(await runHook({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: `curl -X PATCH $API/api/agents/x -d '{"adapterConfig":{"model":"claude-sonnet-4-6"}}'` },
      }));
      expect(denied.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
      expect(denied.hookSpecificOutput.permissionDecisionReason).toContain("Models are mine");

      expect(await runHook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } })).toBe("");

      // "Write a script, then run it": the hook reads the script, so the
      // classifier sees what it does even though the command is just "bash".
      await writeFile(path.join(dir, "switch_model.sh"), `#!/bin/bash\ncurl -X PATCH $API/api/agents/x -d '{"adapterConfig":{"model":"claude-sonnet-4-6"}}'\n`);
      const viaScript = JSON.parse(await runHook({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        cwd: dir,
        tool_input: { command: "cd /tmp && bash " + path.join(dir, "switch_model.sh") + " && echo done" },
      }));
      expect(viaScript.hookSpecificOutput.permissionDecision).toBe("deny");
      const relative = JSON.parse(await runHook({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        cwd: dir,
        tool_input: { command: "./switch_model.sh" },
      }));
      expect(relative.hookSpecificOutput.permissionDecision).toBe("deny");
      const scriptCall = calls.find((call) => JSON.stringify(call.toolInput).includes("scriptContents"));
      expect(JSON.stringify(scriptCall?.toolInput)).toContain("claude-sonnet-4-6");
      // A harmless script still runs.
      await writeFile(path.join(dir, "tests.sh"), "#!/bin/bash\npnpm test\n");
      expect(await runHook({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: dir, tool_input: { command: "bash tests.sh" } })).toBe("");
      expect(await runHook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/x" } })).toBe("");

      const started = JSON.parse(await runHook({ hook_event_name: "SessionStart", source: "startup" }));
      expect(started.hookSpecificOutput.hookEventName).toBe("SessionStart");
      expect(started.hookSpecificOutput.additionalContext).toContain("Never change another agent's model or effort");
    } finally {
      server.close();
    }
  });
});
