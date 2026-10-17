import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { buildGithubGitAuthEnv, resolveGithubConnectorAccessToken } from "../services/github-git-auth.js";

// GIT_CONFIG_COUNT/KEY_n/VALUE_n env config requires git >= 2.31.
const gitSupportsEnvConfig = (() => {
  try {
    const match = execFileSync("git", ["--version"], { encoding: "utf8" }).match(/(\d+)\.(\d+)/);
    return Boolean(match && (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) >= 31)));
  } catch {
    return false;
  }
})();

function registry(input: { user?: string | null; agent?: string | null }) {
  return {
    getCredentialsAsync: vi.fn(async () => (input.user ? { accessToken: input.user } : null)),
    getCredentialsForAgentAsync: vi.fn(async () =>
      input.agent ? { credentials: { accessToken: input.agent }, sourceUserId: "u1" } : null),
  };
}

describe("resolveGithubConnectorAccessToken", () => {
  it("prefers the requesting user's token", async () => {
    const reg = registry({ user: "user-token", agent: "agent-token" });
    await expect(resolveGithubConnectorAccessToken(reg, "c1", "u2")).resolves.toBe("user-token");
    expect(reg.getCredentialsForAgentAsync).not.toHaveBeenCalled();
  });

  it("falls back to agent-scoped credentials when no user started the run", async () => {
    const reg = registry({ user: null, agent: "agent-token" });
    await expect(resolveGithubConnectorAccessToken(reg, "c1", null)).resolves.toBe("agent-token");
  });

  it("returns null when the connector has no credentials", async () => {
    await expect(resolveGithubConnectorAccessToken(registry({}), "c1", null)).resolves.toBeNull();
  });
});

describe("buildGithubGitAuthEnv", () => {
  it("sets GH_TOKEN/GITHUB_TOKEN and git config for github.com", () => {
    const { env, secretKeys } = buildGithubGitAuthEnv({}, "tok");
    expect(env.GH_TOKEN).toBe("tok");
    expect(env.GITHUB_TOKEN).toBe("tok");
    expect(env.GIT_CONFIG_COUNT).toBe("3");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    expect(env.GIT_CONFIG_VALUE_0).toBe(
      `AUTHORIZATION: basic ${Buffer.from("x-access-token:tok").toString("base64")}`,
    );
    expect(secretKeys).toEqual(["GH_TOKEN", "GITHUB_TOKEN", "GIT_CONFIG_VALUE_0"]);
  });

  it("keeps explicitly configured tokens and appends after existing git config entries", () => {
    const { env, secretKeys } = buildGithubGitAuthEnv(
      { GH_TOKEN: "explicit", GIT_CONFIG_COUNT: "2" },
      "tok",
    );
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBe("tok");
    expect(env.GIT_CONFIG_KEY_2).toBe("http.https://github.com/.extraheader");
    expect(env.GIT_CONFIG_COUNT).toBe("5");
    expect(secretKeys).toEqual(["GITHUB_TOKEN", "GIT_CONFIG_VALUE_2"]);
  });

  it.skipIf(!gitSupportsEnvConfig)("is understood by git: header applies to github.com and SSH URLs rewrite to HTTPS", () => {
    const { env } = buildGithubGitAuthEnv({}, "tok");
    const gitEnv = { ...process.env, ...env, GIT_CONFIG_NOSYSTEM: "1", HOME: "/nonexistent" };
    const header = execFileSync(
      "git",
      ["config", "--get-urlmatch", "http.extraheader", "https://github.com/org/repo.git"],
      { env: gitEnv, encoding: "utf8" },
    ).trim();
    expect(header).toBe(env.GIT_CONFIG_VALUE_0);
    const rewrites = execFileSync("git", ["config", "--get-all", "url.https://github.com/.insteadof"], {
      env: gitEnv,
      encoding: "utf8",
    }).trim().split("\n");
    expect(rewrites).toEqual(["git@github.com:", "ssh://git@github.com/"]);
  });
});
