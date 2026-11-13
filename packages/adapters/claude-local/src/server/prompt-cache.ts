import fs from "node:fs/promises";
import path from "node:path";
import { createHash, type Hash } from "node:crypto";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  ensurePaperclipSkillSymlink,
  resolvePaperclipInstanceRootForAdapter,
  type PaperclipSkillEntry,
} from "@paperclipai/adapter-utils/server-utils";

type SkillEntry = PaperclipSkillEntry;

export interface ClaudePromptBundle {
  bundleKey: string;
  rootDir: string;
  addDir: string;
  instructionsFilePath: string | null;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveManagedClaudePromptCacheRoot(
  env: NodeJS.ProcessEnv,
  companyId: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return path.resolve(
    instanceRoot,
    "companies",
    companyId,
    "claude-prompt-cache",
  );
}

async function hashPathContents(
  candidate: string,
  hash: Hash,
  relativePath: string,
  seenDirectories: Set<string>,
): Promise<void> {
  const stat = await fs.lstat(candidate);

  if (stat.isSymbolicLink()) {
    hash.update(`symlink:${relativePath}\n`);
    const resolved = await fs.realpath(candidate).catch(() => null);
    if (!resolved) {
      hash.update("missing\n");
      return;
    }
    await hashPathContents(resolved, hash, relativePath, seenDirectories);
    return;
  }

  if (stat.isDirectory()) {
    const realDir = await fs.realpath(candidate).catch(() => candidate);
    hash.update(`dir:${relativePath}\n`);
    if (seenDirectories.has(realDir)) {
      hash.update("loop\n");
      return;
    }
    seenDirectories.add(realDir);
    const entries = await fs.readdir(candidate, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelativePath = relativePath.length > 0 ? `${relativePath}/${entry.name}` : entry.name;
      await hashPathContents(path.join(candidate, entry.name), hash, childRelativePath, seenDirectories);
    }
    return;
  }

  if (stat.isFile()) {
    hash.update(`file:${relativePath}\n`);
    hash.update(await fs.readFile(candidate));
    hash.update("\n");
    return;
  }

  hash.update(`other:${relativePath}:${stat.mode}\n`);
}

async function buildClaudePromptBundleKey(input: {
  skills: SkillEntry[];
  instructionsContents: string | null;
}): Promise<string> {
  const hash = createHash("sha256");
  hash.update("paperclip-claude-prompt-bundle:v1\n");
  if (input.instructionsContents) {
    hash.update("instructions\n");
    hash.update(input.instructionsContents);
    hash.update("\n");
  } else {
    hash.update("instructions:none\n");
  }

  const sortedSkills = [...input.skills].sort((left, right) => left.runtimeName.localeCompare(right.runtimeName));
  for (const entry of sortedSkills) {
    hash.update(`skill:${entry.key}:${entry.runtimeName}\n`);
    await hashPathContents(entry.source, hash, entry.runtimeName, new Set<string>());
  }

  return hash.digest("hex");
}

async function isReadableRegularFile(targetPath: string): Promise<boolean> {
  // stat() follows symlinks, so a symlink pointing at a real file counts as
  // readable. A character device (e.g. a leftover /dev/null stub) is readable
  // too, but bwrap cannot use it as a bind-mount source, so it must be
  // replaced with a real file.
  const stat = await fs.stat(targetPath).catch(() => null);
  return stat !== null && stat.isFile();
}

async function ensureReadableFile(
  targetPath: string,
  contents: string,
  options: { force?: boolean } = {},
): Promise<void> {
  if (!options.force && (await isReadableRegularFile(targetPath))) {
    return;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const existing = await fs.lstat(targetPath).catch(() => null);
  if (existing?.isDirectory()) {
    await fs.rm(targetPath, { recursive: true, force: true });
  }
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, contents, "utf8");
    await fs.chmod(tempPath, 0o644);
    await fs.rename(tempPath, targetPath);
  } catch (err) {
    const targetReadable = await isReadableRegularFile(targetPath);
    if (!targetReadable) {
      throw err;
    }
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

/**
 * The claude-local sandbox bind-mounts the prompt bundle directory. Claude Code's
 * sandbox enumerates `.mcp.json` inside it and aborts the whole bwrap invocation
 * with "Can't get type of source .../.mcp.json" when the file is absent, which
 * kills every Bash tool call in the run. Materialize it eagerly so a bundle dir
 * can never be born without it.
 */
const EMPTY_MCP_CONFIG_CONTENTS = `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`;

/**
 * A bundle `.mcp.json` is only usable if Claude Code can parse it. An empty or
 * otherwise invalid file is reported by Claude Code as
 * "[Failed to parse] Project config (shared via .mcp.json)", so it is repaired
 * the same way a missing file is.
 */
async function isUsableBundleMcpConfig(targetPath: string): Promise<boolean> {
  if (!(await isReadableRegularFile(targetPath))) return false;
  const raw = await fs.readFile(targetPath, "utf8").catch(() => null);
  if (raw === null) return false;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const mcpServers = (parsed as Record<string, unknown>).mcpServers;
    return mcpServers !== undefined && mcpServers !== null && typeof mcpServers === "object";
  } catch {
    return false;
  }
}

async function ensureBundleMcpConfig(bundleDir: string): Promise<void> {
  const mcpConfigPath = path.join(bundleDir, ".mcp.json");
  if (await isUsableBundleMcpConfig(mcpConfigPath)) {
    return;
  }
  await ensureReadableFile(mcpConfigPath, EMPTY_MCP_CONFIG_CONTENTS, { force: true });
}

/**
 * Repairs bundle directories that were created before `.mcp.json` was
 * materialized, so an existing bundle is never left in the state that aborts
 * the sandbox.
 */
async function repairClaudePromptCacheBundles(
  cacheRoot: string,
  onLog: AdapterExecutionContext["onLog"],
): Promise<string[]> {
  const repaired: string[] = [];
  const entries = await fs.readdir(cacheRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const bundleDir = path.join(cacheRoot, entry.name);
    try {
      const mcpConfigPath = path.join(bundleDir, ".mcp.json");
      if (await isUsableBundleMcpConfig(mcpConfigPath)) continue;
      await ensureBundleMcpConfig(bundleDir);
      repaired.push(bundleDir);
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to materialize .mcp.json in "${bundleDir}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  return repaired;
}

export async function prepareClaudePromptBundle(input: {
  companyId: string;
  skills: SkillEntry[];
  instructionsContents: string | null;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<ClaudePromptBundle> {
  const { companyId, skills, instructionsContents, onLog } = input;
  const bundleKey = await buildClaudePromptBundleKey({
    skills,
    instructionsContents,
  });
  const cacheRoot = resolveManagedClaudePromptCacheRoot(process.env, companyId);
  const rootDir = path.join(cacheRoot, bundleKey);
  const skillsHome = path.join(rootDir, ".claude", "skills");
  await fs.mkdir(skillsHome, { recursive: true });

  for (const entry of skills) {
    const target = path.join(skillsHome, entry.runtimeName);
    try {
      await ensurePaperclipSkillSymlink(entry.source, target);
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to materialize Claude skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  const instructionsFilePath = instructionsContents
    ? path.join(rootDir, "agent-instructions.md")
    : null;
  if (instructionsFilePath && instructionsContents) {
    await ensureReadableFile(instructionsFilePath, instructionsContents);
  }

  await ensureBundleMcpConfig(rootDir);

  const repairedBundles = await repairClaudePromptCacheBundles(cacheRoot, onLog);
  if (repairedBundles.length > 0) {
    await onLog(
      "stdout",
      `[paperclip] Materialized .mcp.json in ${repairedBundles.length} existing Claude prompt bundle(s).\n`,
    );
  }

  return {
    bundleKey,
    rootDir,
    addDir: rootDir,
    instructionsFilePath,
  };
}
