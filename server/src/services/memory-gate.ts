import { readFile } from "node:fs/promises";

/**
 * Host memory gate for the run scheduler.
 *
 * Every agent run spawns a CLI process tree (Claude Code / Codex, MCP servers,
 * sometimes headless Chrome or test runners). Started in parallel on a small
 * box, they can exhaust RAM and swap; the kernel OOM killer then kills the
 * Paperclip server and every in-flight run is lost (and retried from scratch,
 * paying for the tokens twice). This gate stops new runs from starting while
 * available memory is below a floor, and spaces out starts so a burst cannot
 * overshoot before the freshly started processes have grown.
 */

/** Memory a freshly started run is assumed to take once it has ramped up. */
export const RUN_MEMORY_ESTIMATE_MB = 600;
/** How long a just-started run counts against the headroom before it is visible in MemAvailable. */
export const RUN_MEMORY_RAMP_MS = 90_000;

export interface HostMemorySnapshot {
  availableMb: number | null;
  totalMb: number | null;
}

export function parseMeminfo(text: string): HostMemorySnapshot {
  const readKb = (key: string) => {
    const match = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m").exec(text);
    return match ? Number(match[1]) : null;
  };
  const availableKb = readKb("MemAvailable");
  const totalKb = readKb("MemTotal");
  return {
    availableMb: availableKb === null ? null : Math.floor(availableKb / 1024),
    totalMb: totalKb === null ? null : Math.floor(totalKb / 1024),
  };
}

async function readProcMeminfo(): Promise<HostMemorySnapshot> {
  try {
    return parseMeminfo(await readFile("/proc/meminfo", "utf8"));
  } catch {
    // Not Linux (local dev on macOS) or unreadable: the gate fails open.
    return { availableMb: null, totalMb: null };
  }
}

let hostMemoryReader: () => Promise<HostMemorySnapshot> = readProcMeminfo;

export function readHostMemory(): Promise<HostMemorySnapshot> {
  return hostMemoryReader();
}

/** Tests only: replace the /proc/meminfo reader. Pass null to restore it. */
export function setHostMemoryReaderForTests(reader: (() => Promise<HostMemorySnapshot>) | null) {
  hostMemoryReader = reader ?? readProcMeminfo;
}

export interface MemoryGateDecision {
  /** How many of the wanted runs may start now. */
  allowed: number;
  /** True when fewer than `wanted` may start because of memory. */
  blocked: boolean;
  /** Headroom left after the floor and recently started runs, in MB (null when unknown). */
  headroomMb: number | null;
}

export function decideMemoryGate(input: {
  wanted: number;
  availableMb: number | null;
  minFreeMb: number;
  recentStarts: number;
  perRunMb?: number;
}): MemoryGateDecision {
  const wanted = Math.max(0, input.wanted);
  if (wanted === 0) return { allowed: 0, blocked: false, headroomMb: null };
  if (input.minFreeMb <= 0 || input.availableMb === null) {
    return { allowed: wanted, blocked: false, headroomMb: null };
  }
  const perRunMb = input.perRunMb ?? RUN_MEMORY_ESTIMATE_MB;
  const headroomMb = input.availableMb - input.minFreeMb - input.recentStarts * perRunMb;
  // A run may start only if the floor still holds after it has grown to the estimate.
  const allowed = Math.max(0, Math.min(wanted, Math.floor(headroomMb / perRunMb)));
  return { allowed, blocked: allowed < wanted, headroomMb };
}
