/** Config + path resolution. Secrets are written atomically with mode 0600. */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OAuthConfig } from "./types.js";

export interface Dirs {
  configDir: string;
  cacheDir: string;
}

/**
 * Resolve config/cache directories.
 * Precedence: MEETNOTES_HOME (both) > XDG_*_HOME > ~/.config & ~/.cache.
 */
export function resolveDirs(env: NodeJS.ProcessEnv = process.env): Dirs {
  const home = env.MEETNOTES_HOME;
  if (home) {
    return { configDir: join(home, "config"), cacheDir: join(home, "cache") };
  }
  const xdgConfig = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const xdgCache = env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return {
    configDir: join(xdgConfig, "gmeet-notes"),
    cacheDir: join(xdgCache, "gmeet-notes"),
  };
}

export function oauthPath(dirs: Dirs): string {
  return join(dirs.configDir, "oauth.json");
}

export function storePath(dirs: Dirs): string {
  return join(dirs.cacheDir, "store.json");
}

/** Write JSON atomically (temp file + rename) with an optional file mode. */
export function atomicWriteJson(path: string, value: unknown, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export function saveConfig(dirs: Dirs, cfg: OAuthConfig): void {
  atomicWriteJson(oauthPath(dirs), cfg, 0o600);
}

// --- runtime credentials --------------------------------------------------

/**
 * Per-invocation credential overrides. Lets an agent supply OAuth credentials
 * at runtime (no config file, no browser). Precedence: flags > env > file.
 */
export interface AuthOverrides {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  email?: string;
  calendarId?: string;
}

/** Environment variables read for runtime credential injection. */
export const ENV_KEYS = {
  clientId: "GMEET_CLIENT_ID",
  clientSecret: "GMEET_CLIENT_SECRET",
  refreshToken: "GMEET_REFRESH_TOKEN",
  accessToken: "GMEET_ACCESS_TOKEN",
  email: "GMEET_EMAIL",
  calendarId: "GMEET_CALENDAR_ID",
} as const;

export interface ResolvedAuth {
  cfg: OAuthConfig;
  /**
   * True when the OAuth secrets (client id/secret, tokens) came entirely from
   * the on-disk config file. Refreshes are only persisted back to disk in that
   * case — runtime-injected credentials stay stateless.
   */
  secretsFromFile: boolean;
}

/**
 * Resolve credentials from flags, then env vars, then the config file. Fails
 * closed if no usable credential set can be assembled.
 */
export function resolveAuth(
  dirs: Dirs,
  overrides: AuthOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAuth {
  let file: Record<string, unknown> = {};
  let fileExists = false;
  try {
    const raw: unknown = JSON.parse(readFileSync(oauthPath(dirs), "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      file = raw as Record<string, unknown>;
      fileExists = true;
    }
  } catch {
    // No config file — that's fine when credentials are injected at runtime.
  }

  const pick = (flag: string | undefined, envKey: string, fileVal: unknown): string | undefined => {
    if (flag) return flag;
    const fromEnv = env[envKey];
    if (fromEnv) return fromEnv;
    return typeof fileVal === "string" && fileVal ? fileVal : undefined;
  };

  const clientId = pick(overrides.clientId, ENV_KEYS.clientId, file.client_id);
  const clientSecret = pick(overrides.clientSecret, ENV_KEYS.clientSecret, file.client_secret);
  const refreshToken = pick(overrides.refreshToken, ENV_KEYS.refreshToken, file.refresh_token);
  const accessToken = pick(overrides.accessToken, ENV_KEYS.accessToken, file.access_token);
  const email = pick(overrides.email, ENV_KEYS.email, file.email) ?? "";
  const calendarId = pick(overrides.calendarId, ENV_KEYS.calendarId, file.calendar_id) ?? (email || "primary");

  const secretsFromFile =
    fileExists &&
    !overrides.clientId &&
    !overrides.clientSecret &&
    !overrides.refreshToken &&
    !overrides.accessToken &&
    !env[ENV_KEYS.clientId] &&
    !env[ENV_KEYS.clientSecret] &&
    !env[ENV_KEYS.refreshToken] &&
    !env[ENV_KEYS.accessToken];

  const cfg: OAuthConfig = {
    client_id: clientId ?? "",
    client_secret: clientSecret ?? "",
    refresh_token: refreshToken ?? "",
    access_token: accessToken,
    email,
    calendar_id: calendarId,
    expires_at: typeof file.expires_at === "number" ? file.expires_at : undefined,
    scope: typeof file.scope === "string" ? file.scope : undefined,
    token_endpoint: typeof file.token_endpoint === "string" ? file.token_endpoint : undefined,
  };

  const hasRefresh = Boolean(cfg.refresh_token && cfg.client_id && cfg.client_secret);
  if (!cfg.access_token && !hasRefresh) {
    throw new Error(
      "no credentials: run `gmeet-notes auth setup`, or inject at runtime via " +
        "GMEET_CLIENT_ID/GMEET_CLIENT_SECRET/GMEET_REFRESH_TOKEN " +
        "(or --client-id/--client-secret/--refresh-token)",
    );
  }
  return { cfg, secretsFromFile };
}
