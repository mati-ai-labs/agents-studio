/** CLI: strict argument parsing + command handlers. No dependencies. */

import { runAuthSetup } from "./auth.js";
import { resolveAuth, resolveDirs, type AuthOverrides, type Dirs } from "./config.js";
import { refreshAccessToken, runCheck, runSync } from "./core.js";
import {
  getNoteBySubstring,
  loadStore,
  markProcessed,
  publicItem,
  saveStore,
  searchNotes,
  sortedNotes,
} from "./storage.js";
import type { NoteRecord } from "./types.js";
import { sanitizeForTerminal } from "./util.js";

export const HELP = `gmeet-notes — capture & query Google Meet "Take notes with Gemini" Smart Notes

Usage: gmeet-notes <command> [options]

Commands:
  auth setup --client-id <id> --client-secret <secret> [--email <you>] [--port 8765]
                       One-time interactive OAuth (PKCE), for a human. Writes config.
  auth refresh         Force-refresh the access token.
  sync [--json] [--days N] [--all] [--since ISO]
                       Capture + correlate NEW notes since the last checkpoint.
  list [--from ISO --to ISO --limit N --json]
                       List cached notes (newest first; '*' = unprocessed).
  get <id> [--json]    Print one cached note (id is substring-matched).
  search <query> [--limit N --json]
                       Full-text search over cached notes.
  mark-processed <id...> [--json]
                       Mark notes as acted-on (prevents reprocessing).
  stats [--json]       Cache size, unprocessed count, last sync time.
  check                Validate auth + Meet/Calendar access (read-only).
  selftest             Offline test (no Google account needed).
  help                 Show this help.

Runtime credentials (for agents — no browser, no config file needed):
  Any command that needs auth accepts credentials via env vars or flags
  (precedence: flags > env > config file):
    --client-id / GMEET_CLIENT_ID
    --client-secret / GMEET_CLIENT_SECRET
    --refresh-token / GMEET_REFRESH_TOKEN
    --access-token / GMEET_ACCESS_TOKEN     (short-lived token, used as-is)
    --email / GMEET_EMAIL                   (correlation account)
    --calendar-id / GMEET_CALENDAR_ID
  Runtime-injected credentials are stateless: no file is written.

Env: MEETNOTES_HOME overrides config+cache location (else XDG / ~/.config, ~/.cache).`;

interface Parsed {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

const KNOWN_FLAGS = new Set([
  "json",
  "days",
  "all",
  "since",
  "from",
  "to",
  "limit",
  "email",
  "client-id",
  "client-secret",
  "refresh-token",
  "access-token",
  "calendar-id",
  "port",
]);

const VALUE_FLAGS = new Set([
  "days",
  "since",
  "from",
  "to",
  "limit",
  "email",
  "client-id",
  "client-secret",
  "refresh-token",
  "access-token",
  "calendar-id",
  "port",
]);

export function parseArgs(argv: string[]): Parsed {
  const [command = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (!KNOWN_FLAGS.has(name)) throw new Error(`unknown option: --${name}`);
      if (VALUE_FLAGS.has(name)) {
        const value = rest[i + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new Error(`option --${name} requires a value`);
        }
        flags[name] = value;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { command, positionals, flags };
}

function flagStr(flags: Parsed["flags"], name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

function flagInt(flags: Parsed["flags"], name: string, fallback: number): number {
  const v = flagStr(flags, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
  return n;
}

/** Collect runtime credential flags into overrides (env vars applied later in resolveAuth). */
function buildOverrides(flags: Parsed["flags"]): AuthOverrides {
  return {
    clientId: flagStr(flags, "client-id"),
    clientSecret: flagStr(flags, "client-secret"),
    refreshToken: flagStr(flags, "refresh-token"),
    accessToken: flagStr(flags, "access-token"),
    email: flagStr(flags, "email"),
    calendarId: flagStr(flags, "calendar-id"),
  };
}

function out(json: boolean, value: unknown, human: () => void): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    human();
  }
}

/** Print untrusted note text to the terminal safely. */
function safePrint(text: string): void {
  process.stdout.write(sanitizeForTerminal(text) + "\n");
}

async function cmdAuth(dirs: Dirs, parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0];
  if (sub === "setup") {
    const clientId = flagStr(parsed.flags, "client-id");
    const clientSecret = flagStr(parsed.flags, "client-secret");
    if (!clientId || !clientSecret) {
      throw new Error("auth setup requires --client-id and --client-secret");
    }
    await runAuthSetup(dirs, {
      clientId,
      clientSecret,
      email: flagStr(parsed.flags, "email"),
      port: flagInt(parsed.flags, "port", 8765),
    });
    return 0;
  }
  if (sub === "refresh") {
    const { cfg, secretsFromFile } = resolveAuth(dirs, buildOverrides(parsed.flags));
    if (!(cfg.refresh_token && cfg.client_id && cfg.client_secret)) {
      throw new Error("auth refresh needs refresh credentials (client id/secret + refresh token)");
    }
    await refreshAccessToken(dirs, cfg, secretsFromFile);
    console.log("OK: access token refreshed");
    return 0;
  }
  throw new Error("usage: gmeet-notes auth <setup|refresh> ...");
}

async function cmdSync(dirs: Dirs, parsed: Parsed): Promise<number> {
  const json = parsed.flags.json === true;
  const { batch } = await runSync(
    dirs,
    {
      days: flagInt(parsed.flags, "days", 7),
      all: parsed.flags.all === true,
      since: flagStr(parsed.flags, "since"),
    },
    buildOverrides(parsed.flags),
  );
  out(json, batch, () => {
    if (batch.newCount === 0) {
      console.log(`No new notes (${batch.window.from} to ${batch.window.to}).`);
      return;
    }
    for (const it of batch.items) {
      const title = sanitizeForTerminal(it.calendar.summary ?? "(ad-hoc meeting)");
      console.log(`- [${it.correlation.status}] ${title}  (${it.calendar.organizer ?? "unknown"}, ${(it.meet.actualStart ?? "").slice(0, 16)})`);
      console.log(`    id: ${it.id}`);
    }
  });
  return 0;
}

function cmdList(dirs: Dirs, parsed: Parsed): number {
  const store = loadStore(dirs);
  const notes = sortedNotes(store, {
    from: flagStr(parsed.flags, "from"),
    to: flagStr(parsed.flags, "to"),
    limit: flagInt(parsed.flags, "limit", 25),
  });
  out(parsed.flags.json === true, notes.map(publicItem), () => {
    if (notes.length === 0) {
      console.log("No cached notes. Run: gmeet-notes sync");
      return;
    }
    for (const n of notes) {
      const flag = n.state === "new" ? "*" : " ";
      const when = (n.actual_start ?? n.first_seen ?? "").slice(0, 16);
      console.log(`${flag} ${when}  ${sanitizeForTerminal(n.title ?? "(ad-hoc meeting)")}  [${n.corr_status}]  id=${n.id}`);
    }
  });
  return 0;
}

function cmdGet(dirs: Dirs, parsed: Parsed): number {
  const id = parsed.positionals[0];
  if (!id) throw new Error("usage: gmeet-notes get <id> [--json]");
  const store = loadStore(dirs);
  const note = getNoteBySubstring(store, id);
  if (!note) throw new Error(`no note matching id: ${id}`);
  out(parsed.flags.json === true, publicItem(note), () => {
    console.log(`Title:     ${sanitizeForTerminal(note.title ?? "(ad-hoc meeting)")}`);
    console.log(`Organizer: ${note.organizer ?? ""}`);
    console.log(`When:      ${note.actual_start ?? ""}`);
    console.log(`Code:      ${note.meeting_code}`);
    console.log(`Doc:       ${note.doc_url ?? ""}`);
    console.log(`Match:     ${note.corr_status} (score ${note.corr_score})`);
    console.log(`State:     ${note.state}`);
    console.log("-".repeat(60));
    safePrint(note.content);
  });
  return 0;
}

function cmdSearch(dirs: Dirs, parsed: Parsed): number {
  const query = parsed.positionals.join(" ").trim();
  if (!query) throw new Error("usage: gmeet-notes search <query> [--json]");
  const store = loadStore(dirs);
  const hits = searchNotes(store, query, flagInt(parsed.flags, "limit", 10));
  out(
    parsed.flags.json === true,
    hits.map((h) => ({
      id: h.note.id,
      title: h.note.title,
      actualStart: h.note.actual_start,
      organizer: h.note.organizer,
      docUrl: h.note.doc_url,
      snippet: h.snippet,
    })),
    () => {
      if (hits.length === 0) {
        console.log("No matches.");
        return;
      }
      for (const h of hits) {
        console.log(`${(h.note.actual_start ?? "").slice(0, 16)}  ${sanitizeForTerminal(h.note.title ?? "(ad-hoc)")}`);
        console.log(`    ${sanitizeForTerminal(h.snippet)}`);
        console.log(`    id=${h.note.id}`);
      }
    },
  );
  return 0;
}

function cmdMark(dirs: Dirs, parsed: Parsed): number {
  const ids = parsed.positionals;
  if (ids.length === 0) throw new Error("usage: gmeet-notes mark-processed <id...> [--json]");
  const store = loadStore(dirs);
  const marked = markProcessed(store, ids);
  saveStore(dirs, store);
  out(parsed.flags.json === true, { marked }, () => {
    console.log(`Marked ${marked} note(s) processed.`);
  });
  return 0;
}

function cmdStats(dirs: Dirs, parsed: Parsed): number {
  const store = loadStore(dirs);
  const notes: NoteRecord[] = Object.values(store.notes);
  const total = notes.length;
  const unprocessed = notes.filter((n) => n.state === "new").length;
  const value = { totalNotes: total, unprocessed, lastSync: store.checkpoint.lastSyncTo ?? null };
  out(parsed.flags.json === true, value, () => {
    console.log(`Total notes:   ${total}`);
    console.log(`Unprocessed:   ${unprocessed}`);
    console.log(`Last sync:     ${store.checkpoint.lastSyncTo ?? "never"}`);
  });
  return 0;
}

export async function run(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const dirs = resolveDirs();

  switch (parsed.command) {
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    case "auth":
      return cmdAuth(dirs, parsed);
    case "sync":
      return cmdSync(dirs, parsed);
    case "list":
      return cmdList(dirs, parsed);
    case "get":
      return cmdGet(dirs, parsed);
    case "search":
      return cmdSearch(dirs, parsed);
    case "mark-processed":
      return cmdMark(dirs, parsed);
    case "stats":
      return cmdStats(dirs, parsed);
    case "check":
      return runCheck(dirs, buildOverrides(parsed.flags));
    case "selftest": {
      const { runSelftest } = await import("./selftest.js");
      return runSelftest();
    }
    default:
      console.error(`Unknown command: ${parsed.command}\n`);
      console.error(HELP);
      return 2;
  }
}
