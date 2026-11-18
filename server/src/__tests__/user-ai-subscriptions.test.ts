import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issues, userAiSubscriptions } from "@paperclipai/db";
import {
  CLAUDE_STUDIO_ENV_KEYS_TO_BLANK,
  decideUserSubscriptionForRun,
  detectUserSubscriptionAuthFailure,
  parseCodexAuthJson,
  providerForAdapterType,
  userAiSubscriptionService,
} from "../services/user-ai-subscriptions.js";
import { issueService } from "../services/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const CLAUDE_TOKEN_A = `sk-ant-oat01-${"a".repeat(40)}`;

function fakeIdToken(email: string) {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ email })}.sig`;
}

function codexAuth(email: string, accessToken = "access-1") {
  return JSON.stringify({
    tokens: { account_id: "acct-1", id_token: fakeIdToken(email), access_token: accessToken, refresh_token: "r" },
  });
}

describe("user AI subscription helpers", () => {
  it("never lets another human's wake consume the owner's subscription", () => {
    const base = { ownerUserId: "a", provider: "claude" as const, ownerHasActiveCredential: true, isAssigneeRun: true };
    expect(decideUserSubscriptionForRun({ ...base, wakeUserId: "b" })).toEqual({ kind: "studio_default", reason: "woken_by_other_user" });
    expect(decideUserSubscriptionForRun({ ...base, wakeUserId: "a" })).toEqual({ kind: "use_owner_subscription" });
    expect(decideUserSubscriptionForRun({ ...base, wakeUserId: null })).toEqual({ kind: "use_owner_subscription" });
  });

  it("blocks the assignee run instead of billing the Studio when the owner's credential is missing", () => {
    const base = { ownerUserId: "a", provider: "codex" as const, wakeUserId: null, ownerHasActiveCredential: false };
    expect(decideUserSubscriptionForRun({ ...base, isAssigneeRun: true })).toEqual({ kind: "block" });
    expect(decideUserSubscriptionForRun({ ...base, isAssigneeRun: false })).toEqual({ kind: "studio_default", reason: "owner_has_no_subscription" });
  });

  it("is a no-op for issues without an owner or for unsupported adapters", () => {
    const base = { wakeUserId: null, ownerHasActiveCredential: true, isAssigneeRun: true };
    expect(decideUserSubscriptionForRun({ ...base, ownerUserId: null, provider: "claude" })).toEqual({ kind: "none" });
    expect(decideUserSubscriptionForRun({ ...base, ownerUserId: "a", provider: null })).toEqual({ kind: "none" });
  });

  it("detects provider auth failures", () => {
    expect(detectUserSubscriptionAuthFailure("Failed to authenticate. API Error: 401 OAuth access token is invalid.")).toMatch(/Claude/);
    expect(detectUserSubscriptionAuthFailure("error: refresh_token_reused")).toMatch(/ChatGPT/);
    expect(detectUserSubscriptionAuthFailure("tool failed: rate limited")).toBeNull();
  });

  it("maps only claude_local / codex_local adapters", () => {
    expect(providerForAdapterType("claude_local")).toBe("claude");
    expect(providerForAdapterType("codex_local")).toBe("codex");
    expect(providerForAdapterType("gemini_local")).toBeNull();
  });

  it("accepts ChatGPT auth.json and rejects API-key-only auth.json", () => {
    const ok = parseCodexAuthJson(codexAuth("a@example.com"));
    expect(ok.ok && ok.label).toBe("a@example.com");
    expect(parseCodexAuthJson(JSON.stringify({ OPENAI_API_KEY: "sk-x" })).ok).toBe(false);
    expect(parseCodexAuthJson("not json").ok).toBe(false);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("user AI subscriptions (db)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home!: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-user-ai-subs-");
    db = createDb(tempDb.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "user-ai-subs-home-"));
    for (const key of ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "PAPERCLIP_SECRETS_MASTER_KEY"]) {
      saved[key] = process.env[key];
    }
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "test";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
    // Studio "shared" Claude config with MiniMax routing in settings.env.
    const sharedClaude = path.join(home, "shared-claude");
    await fs.mkdir(sharedClaude, { recursive: true });
    await fs.writeFile(
      path.join(sharedClaude, "settings.json"),
      JSON.stringify({
        env: { ANTHROPIC_BASE_URL: "https://minimax.example", ANTHROPIC_AUTH_TOKEN: "studio", ENABLE_TOOL_SEARCH: "1" },
        permissions: { defaultMode: "bypassPermissions" },
      }),
    );
    process.env.CLAUDE_CONFIG_DIR = sharedClaude;
    const sharedCodex = path.join(home, "shared-codex");
    await fs.mkdir(sharedCodex, { recursive: true });
    await fs.writeFile(path.join(sharedCodex, "config.toml"), 'model = "gpt-5"\n');
    await fs.writeFile(path.join(sharedCodex, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "studio-key" }));
    process.env.CODEX_HOME = sharedCodex;
  }, 30_000);

  afterAll(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await tempDb?.cleanup();
    await fs.rm(home, { recursive: true, force: true });
  });

  it("rejects malformed Claude tokens", async () => {
    await expect(userAiSubscriptionService(db).saveClaudeSetupToken("u-bad", "sk-ant-api03-nope")).rejects.toThrow(/setup token/);
  });

  it("prepares a Claude run that bypasses Studio routing and is isolated per user", async () => {
    const svc = userAiSubscriptionService(db);
    await svc.saveClaudeSetupToken("user-a", CLAUDE_TOKEN_A);

    // Stored encrypted, never in plaintext.
    const row = await db.select().from(userAiSubscriptions).where(eq(userAiSubscriptions.userId, "user-a")).then((r) => r[0]!);
    expect(row.credentialEncrypted).not.toContain("sk-ant-oat01");
    expect((await svc.list("user-a"))[0]).not.toHaveProperty("credentialEncrypted");

    const prepared = await svc.prepareRun({ ownerUserId: "user-a", provider: "claude", adapterConfig: { model: "MiniMax-M3" } });
    expect(prepared).not.toBeNull();
    for (const key of CLAUDE_STUDIO_ENV_KEYS_TO_BLANK) expect(prepared!.envOverrides[key]).toBe("");
    expect(prepared!.envOverrides.CLAUDE_CODE_OAUTH_TOKEN).toBe(CLAUDE_TOKEN_A);
    expect(prepared!.secretEnvKeys).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(prepared!.configPatch.model).toBe("");

    const configDir = prepared!.envOverrides.CLAUDE_CONFIG_DIR!;
    expect(configDir).not.toBe(process.env.CLAUDE_CONFIG_DIR);
    const settings = JSON.parse(await fs.readFile(path.join(configDir, "settings.json"), "utf8"));
    expect(settings.env).toEqual({ ENABLE_TOOL_SEARCH: "1" });
    expect(settings.permissions).toEqual({ defaultMode: "bypassPermissions" });
    // Token never written to disk.
    const files = await fs.readdir(configDir);
    for (const f of files) {
      expect(await fs.readFile(path.join(configDir, f), "utf8")).not.toContain("sk-ant-oat01");
    }
    expect((await fs.stat(configDir)).mode & 0o077).toBe(0);

    // Claude model names are preserved.
    const keep = await svc.prepareRun({ ownerUserId: "user-a", provider: "claude", adapterConfig: { model: "claude-sonnet-4-6" } });
    expect(keep!.configPatch).toEqual({});

    // A different user gets nothing from user A's connection.
    expect(await svc.prepareRun({ ownerUserId: "user-b", provider: "claude", adapterConfig: {} })).toBeNull();
    await svc.saveClaudeSetupToken("user-b", `sk-ant-oat01-${"b".repeat(40)}`);
    const b = await svc.prepareRun({ ownerUserId: "user-b", provider: "claude", adapterConfig: {} });
    expect(b!.envOverrides.CLAUDE_CODE_OAUTH_TOKEN).not.toBe(CLAUDE_TOKEN_A);
    expect(b!.envOverrides.CLAUDE_CONFIG_DIR).not.toBe(configDir);
  });

  it("prepares a Codex run with the user's own CODEX_HOME and keeps refreshed tokens", async () => {
    const svc = userAiSubscriptionService(db);
    await svc.saveCodexAuthJson("user-c", codexAuth("c@example.com"));
    const prepared = await svc.prepareRun({ ownerUserId: "user-c", provider: "codex", adapterConfig: {} });
    expect(prepared!.envOverrides.OPENAI_API_KEY).toBe("");
    const codexHome = prepared!.envOverrides.CODEX_HOME!;
    expect(codexHome).not.toBe(process.env.CODEX_HOME);
    const authPath = path.join(codexHome, "auth.json");
    expect(JSON.parse(await fs.readFile(authPath, "utf8")).tokens.account_id).toBe("acct-1");
    expect(await fs.readFile(path.join(codexHome, "config.toml"), "utf8")).toContain("gpt-5");
    expect(prepared!.accountLabel).toBe("c@example.com");

    // Codex refreshes tokens on disk -> encrypted backup follows.
    await fs.writeFile(authPath, codexAuth("c@example.com", "access-2"));
    await svc.prepareRun({ ownerUserId: "user-c", provider: "codex", adapterConfig: {} });
    // Disk lost -> restored from the (updated) encrypted copy.
    await fs.rm(authPath);
    await svc.prepareRun({ ownerUserId: "user-c", provider: "codex", adapterConfig: {} });
    expect(JSON.parse(await fs.readFile(authPath, "utf8")).tokens.access_token).toBe("access-2");
  });

  it("an invalid or disconnected credential is not used", async () => {
    const svc = userAiSubscriptionService(db);
    await svc.saveClaudeSetupToken("user-d", `sk-ant-oat01-${"d".repeat(40)}`);
    await svc.markInvalid("user-d", "claude", "401");
    expect(await svc.prepareRun({ ownerUserId: "user-d", provider: "claude", adapterConfig: {} })).toBeNull();
    await svc.saveClaudeSetupToken("user-d", `sk-ant-oat01-${"d".repeat(40)}`);
    await svc.disconnect("user-d", "claude");
    expect(await svc.prepareRun({ ownerUserId: "user-d", provider: "claude", adapterConfig: {} })).toBeNull();
  });

  it("sub-issues inherit only for the owner or agents working in the owner's tree", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", adapterType: "claude_local", adapterConfig: {} });
    const svc = issueService(db);
    const parent = await svc.create(companyId, { title: "Parent", createdByUserId: "owner" } as never);
    const other = await svc.create(companyId, { title: "Other", createdByUserId: "someone" } as never);
    await db.update(issues).set({ subscriptionOwnerUserId: "owner" }).where(eq(issues.id, parent.id));

    const byOwner = await svc.create(companyId, { title: "c1", parentId: parent.id, createdByUserId: "owner" } as never);
    const byOtherUser = await svc.create(companyId, { title: "c2", parentId: parent.id, createdByUserId: "intruder" } as never);

    const runOnParent = randomUUID();
    const runOnOther = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: runOnParent, companyId, agentId, status: "running", contextSnapshot: { issueId: parent.id } },
      { id: runOnOther, companyId, agentId, status: "running", contextSnapshot: { issueId: other.id } },
    ] as never);
    const byAgentInTree = await svc.create(companyId, {
      title: "c3", parentId: parent.id, createdByAgentId: agentId, actorRunId: runOnParent,
    } as never);
    const byAgentOutside = await svc.create(companyId, {
      title: "c4", parentId: parent.id, createdByAgentId: agentId, actorRunId: runOnOther,
    } as never);

    const owners = await db.select({ id: issues.id, owner: issues.subscriptionOwnerUserId }).from(issues);
    const ownerOf = (id: string) => owners.find((r) => r.id === id)?.owner ?? null;
    expect(ownerOf(byOwner.id)).toBe("owner");
    expect(ownerOf(byOtherUser.id)).toBeNull();
    expect(ownerOf(byAgentInTree.id)).toBe("owner");
    expect(ownerOf(byAgentOutside.id)).toBeNull();
  }, 30_000);
});
