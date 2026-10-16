import { describe, expect, it } from "vitest";
import { buildOpenCodeMcpConfig } from "./mcp.js";

describe("buildOpenCodeMcpConfig", () => {
  it("converts Paperclip connector hints to OpenCode remote and local MCP configs", () => {
    const result = buildOpenCodeMcpConfig({
      googleWorkspace: {
        url: "http://localhost:8000/mcp",
        accessToken: "google-token",
      },
      jira: {
        serverName: "jira-company",
        command: "uvx",
        args: ["mcp-atlassian", "--read-only"],
      },
      github: {
        url: "https://api.githubcopilot.com/mcp",
        token: "github-token",
      },
      metaAds: {
        url: "https://mcp.facebook.com/ads",
        accessToken: "meta-token",
      },
    });

    expect(result).toEqual({
      "google-workspace": {
        type: "remote",
        url: "http://localhost:8000/mcp",
        enabled: true,
        headers: { Authorization: "Bearer google-token" },
      },
      "jira-company": {
        type: "local",
        command: ["uvx", "mcp-atlassian", "--read-only"],
        enabled: true,
      },
      github: {
        type: "remote",
        url: "https://api.githubcopilot.com/mcp",
        enabled: true,
        headers: { Authorization: "Bearer github-token" },
      },
      "meta-ads": {
        type: "remote",
        url: "https://mcp.facebook.com/ads",
        enabled: true,
        headers: { Authorization: "Bearer meta-token" },
      },
    });
  });

  it("does not emit incomplete or unsupported connector entries", () => {
    expect(
      buildOpenCodeMcpConfig({
        googleWorkspace: { accessToken: "missing-url" },
        unknown: { url: "https://unknown.example/mcp", accessToken: "secret" },
      }),
    ).toEqual({});
  });
});
