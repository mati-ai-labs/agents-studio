import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareClaudePromptBundle } from "./prompt-cache.js";

describe("prepareClaudePromptBundle", () => {
  const cleanupDirs: string[] = [];
  const originalEnv = { ...process.env };

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function createCacheRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-prompt-cache-"));
    cleanupDirs.push(root);
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    return path.join(root, "paperclip-home", "instances", "test-instance", "companies", "company-1", "claude-prompt-cache");
  }

  it("materializes a readable .mcp.json in a newly created bundle dir", async () => {
    const cacheRoot = await createCacheRoot();
    const onLog = vi.fn(async () => {});

    const bundle = await prepareClaudePromptBundle({
      companyId: "company-1",
      skills: [],
      instructionsContents: "# instructions\n",
      onLog,
    });

    const mcpConfigPath = path.join(bundle.rootDir, ".mcp.json");
    const contents = await fs.readFile(mcpConfigPath, "utf8");
    expect(JSON.parse(contents)).toEqual({ mcpServers: {} });
    const stat = await fs.stat(mcpConfigPath);
    expect(stat.isFile()).toBe(true);
  });

  it("materializes .mcp.json even when there are no instructions", async () => {
    const cacheRoot = await createCacheRoot();
    const onLog = vi.fn(async () => {});

    const bundle = await prepareClaudePromptBundle({
      companyId: "company-1",
      skills: [],
      instructionsContents: null,
      onLog,
    });

    const stat = await fs.stat(path.join(bundle.rootDir, ".mcp.json"));
    expect(stat.isFile()).toBe(true);
  });

  it("does not clobber a pre-existing real .mcp.json", async () => {
    const cacheRoot = await createCacheRoot();
    const onLog = vi.fn(async () => {});

    const first = await prepareClaudePromptBundle({
      companyId: "company-1",
      skills: [],
      instructionsContents: "# instructions\n",
      onLog,
    });

    const mcpConfigPath = path.join(first.rootDir, ".mcp.json");
    const custom = JSON.stringify({ mcpServers: { custom: { type: "http", url: "https://example.test/mcp" } } });
    await fs.writeFile(mcpConfigPath, custom, "utf8");

    const second = await prepareClaudePromptBundle({
      companyId: "company-1",
      skills: [],
      instructionsContents: "# instructions\n",
      onLog,
    });

    expect(second.rootDir).toBe(first.rootDir);
    await expect(fs.readFile(mcpConfigPath, "utf8")).resolves.toBe(custom);
  });

  it("replaces a non-regular .mcp.json (e.g. a leftover character device)", async () => {
    const cacheRoot = await createCacheRoot();
    const onLog = vi.fn(async () => {});

    const first = await prepareClaudePromptBundle({
      companyId: "company-1",
      skills: [],
      instructionsContents: "# instructions\n",
      onLog,
    });

    const mcpConfigPath = path.join(first.rootDir, ".mcp.json");
    await fs.rm(mcpConfigPath, { force: true });
    // A directory in place of the file is the same class of breakage as the
    // character device: bwrap cannot bind-mount it as a file.
    await fs.mkdir(mcpConfigPath, { recursive: true });

    const second = await prepareClaudePromptBundle({
      companyId: "company-1",
      skills: [],
      instructionsContents: "# instructions\n",
      onLog,
    });

    const stat = await fs.stat(path.join(second.rootDir, ".mcp.json"));
    expect(stat.isFile()).toBe(true);
    await expect(fs.readFile(path.join(second.rootDir, ".mcp.json"), "utf8"))
      .resolves.toContain("mcpServers");
  });

  it("repairs pre-existing bundle dirs that are missing .mcp.json", async () => {
    const cacheRoot = await createCacheRoot();
    const onLog = vi.fn(async () => {});

    const first = await prepareClaudePromptBundle({
      companyId: "company-1",
      skills: [],
      instructionsContents: "# instructions\n",
      onLog,
    });

    // Simulate a bundle created before .mcp.json was materialized.
    const legacyBundleDir = path.join(cacheRoot, "legacy-bundle-key");
    await fs.mkdir(legacyBundleDir, { recursive: true });
    await fs.writeFile(path.join(legacyBundleDir, "agent-instructions.md"), "# legacy\n", "utf8");

    await prepareClaudePromptBundle({
      companyId: "company-1",
      skills: [],
      instructionsContents: "# instructions\n",
      onLog,
    });

    const legacyStat = await fs.stat(path.join(legacyBundleDir, ".mcp.json"));
    expect(legacyStat.isFile()).toBe(true);
    expect(onLog).toHaveBeenCalledWith(
      "stdout",
      expect.stringContaining("Materialized .mcp.json in 1 existing Claude prompt bundle(s)."),
    );
    expect(first.rootDir).toBeTruthy();
  });

  it("repairs an empty .mcp.json, which Claude Code rejects as invalid JSON", async () => {
    const cacheRoot = await createCacheRoot();
    const onLog = vi.fn(async () => {});

    const first = await prepareClaudePromptBundle({
      companyId: "company-1",
      skills: [],
      instructionsContents: "# instructions\n",
      onLog,
    });

    const mcpConfigPath = path.join(first.rootDir, ".mcp.json");
    await fs.writeFile(mcpConfigPath, "", "utf8");

    const second = await prepareClaudePromptBundle({
      companyId: "company-1",
      skills: [],
      instructionsContents: "# instructions\n",
      onLog,
    });

    const contents = await fs.readFile(path.join(second.rootDir, ".mcp.json"), "utf8");
    expect(JSON.parse(contents)).toEqual({ mcpServers: {} });
  });

  it("repairs a malformed .mcp.json that is not valid JSON", async () => {
    const cacheRoot = await createCacheRoot();
    const onLog = vi.fn(async () => {});

    const first = await prepareClaudePromptBundle({
      companyId: "company-1",
      skills: [],
      instructionsContents: "# instructions\n",
      onLog,
    });

    const mcpConfigPath = path.join(first.rootDir, ".mcp.json");
    await fs.writeFile(mcpConfigPath, "{not json", "utf8");

    const second = await prepareClaudePromptBundle({
      companyId: "company-1",
      skills: [],
      instructionsContents: "# instructions\n",
      onLog,
    });

    const contents = await fs.readFile(path.join(second.rootDir, ".mcp.json"), "utf8");
    expect(JSON.parse(contents)).toEqual({ mcpServers: {} });
  });

  it("keeps a valid pre-existing .mcp.json that declares real servers", async () => {
    const cacheRoot = await createCacheRoot();
    const onLog = vi.fn(async () => {});

    const first = await prepareClaudePromptBundle({
      companyId: "company-1",
      skills: [],
      instructionsContents: "# instructions\n",
      onLog,
    });

    const mcpConfigPath = path.join(first.rootDir, ".mcp.json");
    const custom = JSON.stringify({ mcpServers: { github: { type: "http", url: "https://example.test/mcp" } } });
    await fs.writeFile(mcpConfigPath, custom, "utf8");

    await prepareClaudePromptBundle({
      companyId: "company-1",
      skills: [],
      instructionsContents: "# instructions\n",
      onLog,
    });

    await expect(fs.readFile(mcpConfigPath, "utf8")).resolves.toBe(custom);
  });
});
