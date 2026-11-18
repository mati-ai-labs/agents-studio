/**
 * User-owned AI subscriptions ("run this issue on my own Claude / Codex plan").
 *
 * Isolation invariants (do not weaken):
 *  - A credential row is only ever read for `userId === issue.subscriptionOwnerUserId`.
 *  - `subscriptionOwnerUserId` can only be set to the acting user's own id (see routes).
 *  - Credentials are never returned by the API; only status metadata is.
 *  - The Claude token is passed to the run via env only, never written to disk.
 *  - Each user gets their own config dir (CLAUDE_CONFIG_DIR / CODEX_HOME) under
 *    <instanceRoot>/user-ai-subscriptions/<sha256(userId)>/, mode 0700.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { userAiSubscriptions } from "@paperclipai/db";
import { decryptValue, encryptValue } from "../lib/encryption.js";
import { badRequest } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { models as claudeBuiltinModels } from "@paperclipai/adapter-claude-local";

export type UserAiSubscriptionProvider = "claude" | "codex";
export const USER_AI_SUBSCRIPTION_PROVIDERS: UserAiSubscriptionProvider[] = ["claude", "codex"];

export interface UserAiSubscriptionSummary {
  provider: UserAiSubscriptionProvider;
  status: "active" | "invalid";
  method: string;
  accountLabel: string | null;
  lastError: string | null;
  lastUsedAt: string | null;
  connectedAt: string;
  updatedAt: string;
}

export type CodexDeviceLoginState =
  | { state: "idle" }
  | { state: "pending"; verificationUrl: string | null; userCode: string | null; startedAt: string; expiresAt: string }
  | { state: "succeeded"; finishedAt: string }
  | { state: "failed"; error: string; finishedAt: string };

/** Env keys that carry the Studio default (MiniMax) Claude routing; blanked for user-subscription runs. */
export const CLAUDE_STUDIO_ENV_KEYS_TO_BLANK = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
] as const;

/** Default turn cap for personal-subscription Claude runs (one run can't drain a 5-hour window). */
export const SUBSCRIPTION_DEFAULT_MAX_TURNS = 60;

export const CODEX_STUDIO_ENV_KEYS_TO_BLANK = ["OPENAI_API_KEY", "OPENAI_BASE_URL"] as const;

const CLAUDE_SETUP_TOKEN_RE = /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/;
const DEVICE_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;

export function providerForAdapterType(adapterType: string | null | undefined): UserAiSubscriptionProvider | null {
  if (adapterType === "claude_local") return "claude";
  if (adapterType === "codex_local") return "codex";
  return null;
}

function userDirKey(userId: string): string {
  return createHash("sha256").update(`user-ai-subscription:${userId}`).digest("hex").slice(0, 32);
}

export function resolveUserAiSubscriptionRoot(userId: string): string {
  return path.join(resolvePaperclipInstanceRoot(), "user-ai-subscriptions", userDirKey(userId));
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => undefined);
}

async function writePrivateFile(file: string, contents: string): Promise<void> {
  await ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, contents, { mode: 0o600 });
  await fs.rename(tmp, file);
}

async function readFileOrNull(file: string): Promise<string | null> {
  return fs.readFile(file, "utf8").catch(() => null);
}

/** Mirrors codex-local hasUsableAuthPayload: ChatGPT tokens or an API key. */
export function parseCodexAuthJson(raw: string): { ok: true; json: Record<string, unknown>; label: string | null } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "auth.json is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "auth.json must be a JSON object" };
  }
  const json = parsed as Record<string, unknown>;
  const tokens = json.tokens && typeof json.tokens === "object" && !Array.isArray(json.tokens)
    ? json.tokens as Record<string, unknown>
    : null;
  const hasTokens = Boolean(
    tokens &&
      typeof tokens.account_id === "string" && tokens.account_id.trim() &&
      ["id_token", "access_token", "refresh_token"].some((k) => typeof tokens[k] === "string" && (tokens[k] as string).trim()),
  );
  if (!hasTokens) {
    return { ok: false, error: "auth.json has no ChatGPT login tokens (run `codex login` with your ChatGPT account first)" };
  }
  return { ok: true, json, label: readEmailFromIdToken(tokens?.id_token) };
}

function readEmailFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

function isClaudeModelName(model: string): boolean {
  const m = model.trim().toLowerCase();
  return m.startsWith("claude-") || m === "sonnet" || m === "opus" || m === "haiku" || m.startsWith("sonnet[") || m.startsWith("opus[");
}

function summarize(row: typeof userAiSubscriptions.$inferSelect): UserAiSubscriptionSummary {
  return {
    provider: row.provider as UserAiSubscriptionProvider,
    status: row.status === "invalid" ? "invalid" : "active",
    method: row.method,
    accountLabel: row.accountLabel,
    lastError: row.lastError,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    connectedAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface DeviceLoginSession {
  child: ChildProcess;
  state: CodexDeviceLoginState;
  stagingHome: string;
  timer: NodeJS.Timeout;
}

// Keyed by userId: a user can only see / drive their own login.
const deviceLogins = new Map<string, DeviceLoginSession>();
const deviceLoginResults = new Map<string, CodexDeviceLoginState>();

export interface PreparedUserSubscriptionRun {
  provider: UserAiSubscriptionProvider;
  ownerUserId: string;
  envOverrides: Record<string, string>;
  secretEnvKeys: string[];
  configPatch: Record<string, unknown>;
  accountLabel: string | null;
}

export interface SubscriptionModel {
  id: string;
  label: string;
}

const MODEL_LIST_TTL_MS = 10 * 60 * 1000;
const modelListCache = new Map<string, { expiresAt: number; models: SubscriptionModel[] }>();

async function fetchClaudeSubscriptionModels(token: string): Promise<SubscriptionModel[]> {
  for (const beta of ["oauth-2025-04-20", null]) {
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
      };
      if (beta) headers["anthropic-beta"] = beta;
      const response = await fetch("https://api.anthropic.com/v1/models?limit=100", {
        headers,
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) continue;
      const payload = (await response.json()) as { data?: Array<{ id?: unknown; display_name?: unknown }> };
      const models = (payload.data ?? [])
        .filter((m): m is { id: string; display_name?: unknown } => typeof m.id === "string" && m.id.length > 0)
        .map((m) => ({ id: m.id, label: typeof m.display_name === "string" && m.display_name ? m.display_name : m.id }));
      if (models.length > 0) return models;
    } catch {
      // try next variant / fall back
    }
  }
  return claudeBuiltinModels.map((m) => ({ id: m.id, label: m.label }));
}

async function fetchCodexSubscriptionModels(codexHomeDir: string, codexCommand = "codex"): Promise<SubscriptionModel[]> {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHomeDir, NO_COLOR: "1" };
  for (const key of CODEX_STUDIO_ENV_KEYS_TO_BLANK) delete env[key];
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(codexCommand, ["debug", "models"], { env, cwd: codexHomeDir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("exit", (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`codex debug models exited ${code}`)); });
  });
  const parsed = JSON.parse(stdout) as { models?: Array<Record<string, unknown>> };
  return (parsed.models ?? [])
    .filter((m) => typeof m.slug === "string" && m.visibility !== "hide")
    .map((m) => ({
      id: m.slug as string,
      label: typeof m.display_name === "string" && m.display_name ? m.display_name : (m.slug as string),
    }));
}

export function userAiSubscriptionService(db: Db) {
  async function getRow(userId: string, provider: UserAiSubscriptionProvider) {
    return db
      .select()
      .from(userAiSubscriptions)
      .where(and(eq(userAiSubscriptions.userId, userId), eq(userAiSubscriptions.provider, provider)))
      .then((rows) => rows[0] ?? null);
  }

  async function upsert(input: {
    userId: string;
    provider: UserAiSubscriptionProvider;
    method: string;
    credential: string;
    accountLabel: string | null;
  }) {
    const now = new Date();
    const encrypted = encryptValue(input.credential);
    await db
      .insert(userAiSubscriptions)
      .values({
        userId: input.userId,
        provider: input.provider,
        method: input.method,
        status: "active",
        credentialEncrypted: encrypted,
        accountLabel: input.accountLabel,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [userAiSubscriptions.userId, userAiSubscriptions.provider],
        set: {
          method: input.method,
          status: "active",
          credentialEncrypted: encrypted,
          accountLabel: input.accountLabel,
          lastError: null,
          updatedAt: now,
        },
      });
  }

  function codexHome(userId: string) {
    return path.join(resolveUserAiSubscriptionRoot(userId), "codex-home");
  }

  function claudeConfigDir(userId: string) {
    return path.join(resolveUserAiSubscriptionRoot(userId), "claude-config");
  }

  async function writeCodexAuth(userId: string, authJson: string) {
    await ensurePrivateDir(resolveUserAiSubscriptionRoot(userId));
    await writePrivateFile(path.join(codexHome(userId), "auth.json"), authJson);
  }

  async function finishDeviceLogin(userId: string, session: DeviceLoginSession, exitCode: number | null) {
    clearTimeout(session.timer);
    if (deviceLogins.get(userId) !== session) return;
    deviceLogins.delete(userId);
    const finishedAt = new Date().toISOString();
    try {
      const raw = await readFileOrNull(path.join(session.stagingHome, "auth.json"));
      const parsed = raw ? parseCodexAuthJson(raw) : null;
      if (exitCode === 0 && raw && parsed?.ok) {
        await writeCodexAuth(userId, raw);
        await upsert({ userId, provider: "codex", method: "device_auth", credential: raw, accountLabel: parsed.label });
        deviceLoginResults.set(userId, { state: "succeeded", finishedAt });
      } else if (session.state.state === "pending") {
        const error = parsed && !parsed.ok
          ? parsed.error
          : exitCode === null
            ? "Login timed out or was cancelled"
            : `codex login exited with code ${exitCode}`;
        deviceLoginResults.set(userId, { state: "failed", error, finishedAt });
      }
    } catch (err) {
      deviceLoginResults.set(userId, {
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
        finishedAt,
      });
    } finally {
      await fs.rm(session.stagingHome, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return {
    async list(userId: string): Promise<UserAiSubscriptionSummary[]> {
      const rows = await db.select().from(userAiSubscriptions).where(eq(userAiSubscriptions.userId, userId));
      return rows.map(summarize);
    },

    async get(userId: string, provider: UserAiSubscriptionProvider) {
      const row = await getRow(userId, provider);
      return row ? summarize(row) : null;
    },

    async saveClaudeSetupToken(userId: string, token: string) {
      const trimmed = token.trim();
      if (!CLAUDE_SETUP_TOKEN_RE.test(trimmed)) {
        throw badRequest("That doesn't look like a Claude setup token. Run `claude setup-token` and paste the sk-ant-oat01-… value it prints.");
      }
      await upsert({ userId, provider: "claude", method: "setup_token", credential: trimmed, accountLabel: "Claude subscription (setup-token)" });
      await ensurePrivateDir(claudeConfigDir(userId));
      return this.get(userId, "claude");
    },

    async saveCodexAuthJson(userId: string, raw: string) {
      const parsed = parseCodexAuthJson(raw);
      if (!parsed.ok) throw badRequest(parsed.error);
      const normalized = JSON.stringify(parsed.json, null, 2);
      await writeCodexAuth(userId, normalized);
      await upsert({ userId, provider: "codex", method: "auth_json", credential: normalized, accountLabel: parsed.label });
      return this.get(userId, "codex");
    },

    async startCodexDeviceLogin(userId: string, codexCommand = "codex"): Promise<CodexDeviceLoginState> {
      const existing = deviceLogins.get(userId);
      if (existing) return existing.state;
      deviceLoginResults.delete(userId);
      await ensurePrivateDir(resolveUserAiSubscriptionRoot(userId));
      const stagingHome = await fs.mkdtemp(path.join(resolveUserAiSubscriptionRoot(userId), "codex-login-"));
      await fs.chmod(stagingHome, 0o700).catch(() => undefined);
      const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: stagingHome, NO_COLOR: "1" };
      for (const key of CODEX_STUDIO_ENV_KEYS_TO_BLANK) delete env[key];
      const child = spawn(codexCommand, ["login", "--device-auth"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const startedAt = new Date();
      const session: DeviceLoginSession = {
        child,
        stagingHome,
        state: {
          state: "pending",
          verificationUrl: null,
          userCode: null,
          startedAt: startedAt.toISOString(),
          expiresAt: new Date(startedAt.getTime() + DEVICE_LOGIN_TIMEOUT_MS).toISOString(),
        },
        timer: setTimeout(() => child.kill("SIGTERM"), DEVICE_LOGIN_TIMEOUT_MS),
      };
      deviceLogins.set(userId, session);
      let buffer = "";
      const onData = (chunk: Buffer) => {
        buffer = (buffer + chunk.toString("utf8")).slice(-8000);
        const clean = buffer.replace(ANSI_RE, "");
        const url = clean.match(/https:\/\/auth\.openai\.com\/[^\s]+/)?.[0] ?? null;
        const code = clean.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/)?.[0] ?? null;
        if (session.state.state === "pending") {
          session.state = {
            ...session.state,
            verificationUrl: session.state.verificationUrl ?? url,
            userCode: session.state.userCode ?? code,
          };
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("error", (err) => {
        session.state = { state: "failed", error: `Could not start codex: ${err.message}`, finishedAt: new Date().toISOString() };
        deviceLoginResults.set(userId, session.state);
        void finishDeviceLogin(userId, session, null);
      });
      child.on("exit", (code) => void finishDeviceLogin(userId, session, code));
      // Give the CLI a moment to print the URL + code so the first response is useful.
      for (let i = 0; i < 40 && session.state.state === "pending" && !session.state.userCode; i += 1) {
        await new Promise((r) => setTimeout(r, 250));
      }
      return deviceLogins.get(userId)?.state ?? deviceLoginResults.get(userId) ?? session.state;
    },

    getCodexDeviceLoginState(userId: string): CodexDeviceLoginState {
      return deviceLogins.get(userId)?.state ?? deviceLoginResults.get(userId) ?? { state: "idle" };
    },

    cancelCodexDeviceLogin(userId: string) {
      const session = deviceLogins.get(userId);
      if (session) {
        session.state = { state: "failed", error: "Cancelled", finishedAt: new Date().toISOString() };
        deviceLoginResults.set(userId, session.state);
        session.child.kill("SIGTERM");
      }
    },

    async disconnect(userId: string, provider: UserAiSubscriptionProvider) {
      await db
        .delete(userAiSubscriptions)
        .where(and(eq(userAiSubscriptions.userId, userId), eq(userAiSubscriptions.provider, provider)));
      const dir = provider === "claude" ? claudeConfigDir(userId) : codexHome(userId);
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },

    /** Models available on `userId`'s own subscription, fetched live with their credential. */
    async listModels(userId: string, provider: UserAiSubscriptionProvider): Promise<SubscriptionModel[] | null> {
      const row = await getRow(userId, provider);
      if (!row || row.status !== "active") return null;
      const cacheKey = `${userId}:${provider}:${row.updatedAt.getTime()}`;
      const cached = modelListCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return cached.models;
      let models: SubscriptionModel[];
      if (provider === "claude") {
        models = await fetchClaudeSubscriptionModels(decryptValue(row.credentialEncrypted));
      } else {
        const home = codexHome(userId);
        await ensurePrivateDir(home);
        const authPath = path.join(home, "auth.json");
        const onDisk = await readFileOrNull(authPath);
        if (!onDisk || !parseCodexAuthJson(onDisk).ok) await writePrivateFile(authPath, decryptValue(row.credentialEncrypted));
        models = await fetchCodexSubscriptionModels(home);
      }
      modelListCache.set(cacheKey, { expiresAt: Date.now() + MODEL_LIST_TTL_MS, models });
      return models;
    },

    async markInvalid(userId: string, provider: UserAiSubscriptionProvider, error: string) {
      await db
        .update(userAiSubscriptions)
        .set({ status: "invalid", lastError: error.slice(0, 500), updatedAt: new Date() })
        .where(and(eq(userAiSubscriptions.userId, userId), eq(userAiSubscriptions.provider, provider)));
    },

    /**
     * Build the per-run env/config overrides for `ownerUserId`'s subscription.
     * Returns null when the owner has no active credential for `provider`.
     */
    async prepareRun(input: {
      ownerUserId: string;
      provider: UserAiSubscriptionProvider;
      adapterConfig: Record<string, unknown>;
    }): Promise<PreparedUserSubscriptionRun | null> {
      const row = await getRow(input.ownerUserId, input.provider);
      if (!row || row.status !== "active") return null;
      let credential: string;
      try {
        credential = decryptValue(row.credentialEncrypted);
      } catch {
        await this.markInvalid(input.ownerUserId, input.provider, "Stored credential could not be decrypted; reconnect.");
        return null;
      }
      const configPatch: Record<string, unknown> = {};
      const envOverrides: Record<string, string> = {};
      const secretEnvKeys: string[] = [];

      if (input.provider === "claude") {
        const dir = claudeConfigDir(input.ownerUserId);
        await ensurePrivateDir(dir);
        await seedClaudeConfigDir(dir);
        for (const key of CLAUDE_STUDIO_ENV_KEYS_TO_BLANK) envOverrides[key] = "";
        envOverrides.CLAUDE_CONFIG_DIR = dir;
        envOverrides.CLAUDE_CODE_OAUTH_TOKEN = credential;
        secretEnvKeys.push("CLAUDE_CODE_OAUTH_TOKEN");
        const model = typeof input.adapterConfig.model === "string" ? input.adapterConfig.model : "";
        // Studio agents may pin a MiniMax model; that name is meaningless on Anthropic.
        if (model.trim() && !isClaudeModelName(model)) configPatch.model = "";
      } else {
        const home = codexHome(input.ownerUserId);
        await ensurePrivateDir(home);
        const authPath = path.join(home, "auth.json");
        const onDisk = await readFileOrNull(authPath);
        if (!onDisk || !parseCodexAuthJson(onDisk).ok) {
          // Restore from the encrypted copy.
          await writePrivateFile(authPath, credential);
        } else if (onDisk !== credential) {
          // Codex refreshed its tokens on disk; keep the encrypted backup current.
          await db
            .update(userAiSubscriptions)
            .set({ credentialEncrypted: encryptValue(onDisk), updatedAt: new Date() })
            .where(eq(userAiSubscriptions.id, row.id));
        }
        await seedCodexHome(home);
        for (const key of CODEX_STUDIO_ENV_KEYS_TO_BLANK) envOverrides[key] = "";
        envOverrides.CODEX_HOME = home;
      }

      await db
        .update(userAiSubscriptions)
        .set({ lastUsedAt: new Date() })
        .where(eq(userAiSubscriptions.id, row.id));

      return {
        provider: input.provider,
        ownerUserId: input.ownerUserId,
        envOverrides,
        secretEnvKeys,
        configPatch,
        accountLabel: row.accountLabel,
      };
    },
  };
}

/** Copy the Studio's non-credential Claude settings (permissions etc.), minus env routing. */
async function seedClaudeConfigDir(dir: string): Promise<void> {
  const shared = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
  const rawSettings = await readFileOrNull(path.join(shared, "settings.json"));
  let settings: Record<string, unknown> = {};
  if (rawSettings) {
    try {
      const parsed = JSON.parse(rawSettings);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
    } catch {
      settings = {};
    }
  }
  const env = settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)
    ? { ...(settings.env as Record<string, unknown>) }
    : {};
  for (const key of Object.keys(env)) {
    if (key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_CODE_USE_") || key === "API_TIMEOUT_MS") delete env[key];
  }
  // Personal-subscription runs go straight to Anthropic, so MCP tool search
  // works: always defer MCP tool schemas instead of "auto", which sends every
  // tool definition upfront on large-context models (measured: ~110K tokens per
  // turn with GitHub + Google Workspace MCP vs ~35K).
  env.ENABLE_TOOL_SEARCH = "true";
  settings.env = env;
  delete settings.apiKeyHelper;
  await writePrivateFile(path.join(dir, "settings.json"), JSON.stringify(settings, null, 2));
  const claudeMd = await readFileOrNull(path.join(shared, "CLAUDE.md"));
  if (claudeMd !== null) await writePrivateFile(path.join(dir, "CLAUDE.md"), claudeMd);
}

/** Copy the Studio's Codex config.toml (MCP servers, trust) so behaviour matches; auth stays the user's. */
async function seedCodexHome(home: string): Promise<void> {
  const shared = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  if (path.resolve(shared) === path.resolve(home)) return;
  const toml = await readFileOrNull(path.join(shared, "config.toml"));
  if (toml !== null) await writePrivateFile(path.join(home, "config.toml"), toml);
  const instructions = await readFileOrNull(path.join(shared, "instructions.md"));
  if (instructions !== null) await writePrivateFile(path.join(home, "instructions.md"), instructions);
}

export function assertProvider(value: unknown): UserAiSubscriptionProvider {
  if (value === "claude" || value === "codex") return value;
  throw badRequest("provider must be 'claude' or 'codex'");
}

export type UserSubscriptionRunDecision =
  | { kind: "none" }
  | { kind: "studio_default"; reason: "woken_by_other_user" | "owner_has_no_subscription" }
  | { kind: "use_owner_subscription" }
  | { kind: "block" };

/**
 * Pure policy: who pays for this run.
 *  - no owner / unsupported adapter -> Studio default (unchanged behaviour)
 *  - woken directly by a different human -> Studio default (never their quota)
 *  - owner credential available -> owner's subscription
 *  - otherwise: assignee run is blocked; other agents fall back to Studio default
 */
export function decideUserSubscriptionForRun(input: {
  ownerUserId: string | null;
  provider: UserAiSubscriptionProvider | null;
  wakeUserId: string | null;
  ownerHasActiveCredential: boolean;
  isAssigneeRun: boolean;
}): UserSubscriptionRunDecision {
  if (!input.ownerUserId || !input.provider) return { kind: "none" };
  if (input.wakeUserId && input.wakeUserId !== input.ownerUserId) {
    return { kind: "studio_default", reason: "woken_by_other_user" };
  }
  if (input.ownerHasActiveCredential) return { kind: "use_owner_subscription" };
  return input.isAssigneeRun ? { kind: "block" } : { kind: "studio_default", reason: "owner_has_no_subscription" };
}

const SUBSCRIPTION_AUTH_FAILURE_PATTERNS: Array<[RegExp, string]> = [
  [/OAuth (access )?token (is invalid|has expired|has been revoked)/i, "Claude rejected the token (expired or revoked)"],
  [/API Error: 401/i, "Claude returned 401 Unauthorized"],
  [/invalid bearer token/i, "Claude rejected the token"],
  [/refresh_token_(reused|expired|invalidated)|invalid_grant/i, "ChatGPT login expired; sign in again"],
  [/access token could not be refreshed/i, "ChatGPT login expired; sign in again"],
  [/status 401 Unauthorized/i, "Codex returned 401 Unauthorized"],
];

/** Recognise provider auth failures (not tool/MCP errors) so the UI can ask for a reconnect. */
export function detectUserSubscriptionAuthFailure(text: string): string | null {
  for (const [pattern, message] of SUBSCRIPTION_AUTH_FAILURE_PATTERNS) {
    if (pattern.test(text)) return message;
  }
  return null;
}

export function adapterTypeForProvider(provider: UserAiSubscriptionProvider): "claude_local" | "codex_local" {
  return provider === "claude" ? "claude_local" : "codex_local";
}

export function parseSubscriptionProvider(value: unknown): UserAiSubscriptionProvider | null {
  return value === "claude" || value === "codex" ? value : null;
}

/** Settings that mean the same thing for every local CLI adapter. */
const PORTABLE_ADAPTER_CONFIG_KEYS = [
  "cwd",
  "env",
  "instructionsFilePath",
  "instructionsEntryFile",
  "instructionsRootPath",
  "instructionsBundleMode",
  "paperclipSkillSync",
  "paperclipRuntimeSkills",
  "promptTemplate",
  "bootstrapPromptTemplate",
  "timeoutSec",
  "graceSec",
  "filesystemScope",
  "filesystemExtraPaths",
  "networkScope",
  "networkAllowlist",
  "workspaceStrategy",
  "workspaceRuntime",
] as const;

/**
 * Translate an agent's adapter config for a run that must use a different CLI
 * (the issue owner picked a subscription for another provider). Keeps the
 * agent's instructions, skills, workspace and env; drops CLI-specific knobs
 * and applies the target CLI's unattended defaults.
 */
export function buildSwappedAdapterConfig(
  config: Record<string, unknown>,
  targetProvider: UserAiSubscriptionProvider,
  model: string | null,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const key of PORTABLE_ADAPTER_CONFIG_KEYS) {
    if (config[key] !== undefined) next[key] = config[key];
  }
  if (targetProvider === "codex") {
    next.dangerouslyBypassApprovalsAndSandbox = true;
    next.search = true;
  } else {
    next.dangerouslySkipPermissions = true;
  }
  if (model) next.model = model;
  return next;
}
