import type { ConnectorCredentials } from "./connector-registry.js";

const GITHUB_HTTPS_BASE = "https://github.com/";
const GITHUB_SSH_PREFIXES = ["git@github.com:", "ssh://git@github.com/"] as const;

export const GITHUB_GIT_AUTH_SECRET_ENV_KEYS = ["GH_TOKEN", "GITHUB_TOKEN"] as const;

interface GithubCredentialSource {
  getCredentialsAsync: (
    companyId: string,
    type: "github",
    opts?: { userId?: string | null },
  ) => Promise<ConnectorCredentials | null>;
  getCredentialsForAgentAsync: (
    companyId: string,
    type: "github",
  ) => Promise<{ credentials: ConnectorCredentials } | null>;
}

function readToken(credentials: ConnectorCredentials | null | undefined): string | null {
  const token = credentials?.accessToken;
  return typeof token === "string" && token.trim().length > 0 ? token.trim() : null;
}

/**
 * Resolve the company's GitHub connector token for a run. Prefers the
 * requesting user's credentials; runs with no requesting user (Slack, agent
 * wakeups, timers) fall back to any configured user's credentials, matching
 * the agent-scoped connector credential lookup.
 */
export async function resolveGithubConnectorAccessToken(
  registry: GithubCredentialSource,
  companyId: string,
  userId: string | null | undefined,
): Promise<string | null> {
  const userToken = readToken(await registry.getCredentialsAsync(companyId, "github", { userId }));
  if (userToken) return userToken;
  const agentLookup = await registry.getCredentialsForAgentAsync(companyId, "github");
  return readToken(agentLookup?.credentials);
}

function readGitConfigCount(env: Record<string, unknown>): number {
  const parsed = Number.parseInt(String(env.GIT_CONFIG_COUNT ?? "0"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Build env vars that let git and the gh CLI authenticate to github.com with
 * the connector token, without writing credentials to disk. git reads
 * GIT_CONFIG_COUNT/KEY_n/VALUE_n as command-line config; existing entries are
 * preserved and explicitly configured GH_TOKEN/GITHUB_TOKEN values win.
 */
export function buildGithubGitAuthEnv(
  existingEnv: Record<string, unknown>,
  token: string,
): { env: Record<string, string>; secretKeys: string[] } {
  const env: Record<string, string> = {};
  const secretKeys: string[] = [];
  for (const key of GITHUB_GIT_AUTH_SECRET_ENV_KEYS) {
    const existing = existingEnv[key];
    if (existing !== undefined && existing !== null && String(existing).trim() !== "") continue;
    env[key] = token;
    secretKeys.push(key);
  }

  const baseIndex = readGitConfigCount(existingEnv);
  const basicAuth = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  const entries: Array<[string, string, boolean]> = [
    [`http.${GITHUB_HTTPS_BASE}.extraheader`, `AUTHORIZATION: basic ${basicAuth}`, true],
    ...GITHUB_SSH_PREFIXES.map((prefix) => [`url.${GITHUB_HTTPS_BASE}.insteadOf`, prefix, false] as [string, string, boolean]),
  ];
  entries.forEach(([key, value, secret], offset) => {
    const index = baseIndex + offset;
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
    if (secret) secretKeys.push(`GIT_CONFIG_VALUE_${index}`);
  });
  env.GIT_CONFIG_COUNT = String(baseIndex + entries.length);
  return { env, secretKeys };
}
