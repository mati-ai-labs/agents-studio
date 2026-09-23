import { describe, expect, it } from "vitest";
import { buildCodexExecArgs, buildCodexMcpOverrides } from "./codex-args.js";

describe("buildCodexExecArgs", () => {
  it("converts run-scoped HTTP MCP hints into safe Codex overrides", () => {
    const mcp = buildCodexMcpOverrides({
      github: {
        serverName: "github",
        url: "https://api.githubcopilot.com/mcp",
        accessToken: "github-token",
      },
    });

    expect(mcp.serverNames).toEqual(["github"]);
    expect(mcp.env).toEqual({ PAPERCLIP_MCP_GITHUB_TOKEN: "github-token" });
    expect(mcp.args).toEqual([
      "-c",
      'mcp_servers.github.url="https://api.githubcopilot.com/mcp"',
      "-c",
      'mcp_servers.github.bearer_token_env_var="PAPERCLIP_MCP_GITHUB_TOKEN"',
      "-c",
      "mcp_servers.github.enabled=true",
    ]);
    expect(mcp.args.join(" ")).not.toContain("github-token");
  });

  it("adds MCP overrides after the normal Codex invocation settings", () => {
    const result = buildCodexExecArgs(
      { model: "gpt-5.6-luna" },
      { mcpOverrides: ["-c", "mcp_servers.github.enabled=true"] },
    );

    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.6-luna",
      "-c",
      "mcp_servers.github.enabled=true",
      "-",
    ]);
  });

  it("enables Codex fast mode overrides for GPT-5.4", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4",
      search: true,
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "--search",
      "exec",
      "--json",
      "--model",
      "gpt-5.4",
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
      "-",
    ]);
  });

  it("enables Codex fast mode overrides for manual models", () => {
    const result = buildCodexExecArgs({
      model: "custom-codex-model",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "custom-codex-model",
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
      "-",
    ]);
  });

  it("ignores fast mode for unsupported models", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.6-luna",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(false);
    expect(result.fastModeIgnoredReason).toContain(
      "currently only supported on gpt-5.4 or manually configured model IDs",
    );
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.6-luna",
      "-",
    ]);
  });

  it("adds --skip-git-repo-check when requested", () => {
    const result = buildCodexExecArgs(
      {
        model: "gpt-5.6-luna",
      },
      { skipGitRepoCheck: true },
    );

    expect(result.args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.6-luna",
      "-",
    ]);
  });
});
