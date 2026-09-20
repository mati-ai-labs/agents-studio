/** Core engine: auth, hardened Google API access, correlation, capture. */

import { resolveAuth, saveConfig, type AuthOverrides, type Dirs } from "./config.js";
import { loadStore, publicItem, saveStore, upsertNote, type Store } from "./storage.js";
import type { CalEvent, CorrelationResult, NoteRecord, OAuthConfig, SyncBatch } from "./types.js";
import { nowEpochSeconds, parseIso, safeArr, safeObj, safeStr, sha256Hex, toUtcZ, truncate } from "./util.js";

export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const MEET_BASE = "https://meet.googleapis.com";
export const CAL_BASE = "https://www.googleapis.com/calendar/v3";
export const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
export const SCOPES = [
  "https://www.googleapis.com/auth/meetings.space.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/drive.meet.readonly",
];

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Encode a slash-separated resource path segment-by-segment. */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

// --- auth -----------------------------------------------------------------

export async function refreshAccessToken(dirs: Dirs, cfg: OAuthConfig, persist = true): Promise<string> {
  const body = new URLSearchParams({
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
    refresh_token: cfg.refresh_token,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`token refresh failed (HTTP ${res.status}): ${truncate(text)}`);
  }
  const tok = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (typeof tok.access_token !== "string") {
    throw new Error("token refresh returned no access_token");
  }
  cfg.access_token = tok.access_token;
  cfg.expires_at = nowEpochSeconds() + (typeof tok.expires_in === "number" ? tok.expires_in : 3600) - 60;
  // Only persist when the secrets came from the on-disk config file. Runtime-
  // injected credentials stay stateless (no file written).
  if (persist) saveConfig(dirs, cfg);
  return cfg.access_token;
}

export async function getAccessToken(
  dirs: Dirs,
  overrides: AuthOverrides = {},
): Promise<{ token: string; cfg: OAuthConfig }> {
  const { cfg, secretsFromFile } = resolveAuth(dirs, overrides);
  const persist = secretsFromFile;
  const hasRefresh = Boolean(cfg.refresh_token && cfg.client_id && cfg.client_secret);

  // A valid, unexpired access token wins.
  if (cfg.access_token && nowEpochSeconds() < (cfg.expires_at ?? 0)) {
    return { token: cfg.access_token, cfg };
  }
  // Otherwise refresh if we have the credentials to do so.
  if (hasRefresh) {
    const token = await refreshAccessToken(dirs, cfg, persist);
    return { token, cfg };
  }
  // Access-token-only mode (short-lived token supplied by the caller).
  if (cfg.access_token) {
    return { token: cfg.access_token, cfg };
  }
  throw new Error("no usable credentials: need an access token or refresh credentials");
}

// --- http -----------------------------------------------------------------

async function apiGetText(url: string, token: string, accept: string): Promise<string> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: accept } });
  const text = await res.text();
  if (!res.ok) {
    // The URL never contains the token (it's a header), so it's safe to show.
    throw new Error(`HTTP ${res.status} on ${url}: ${truncate(text)}`);
  }
  return text;
}

async function apiGetJson(url: string, token: string): Promise<Record<string, unknown>> {
  const text = await apiGetText(url, token, "application/json");
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  return safeObj(parsed);
}

// --- google api reads -----------------------------------------------------

export async function listConferenceRecords(
  token: string,
  timeMin: string,
  timeMax: string,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({
      filter: `start_time>="${timeMin}" AND end_time<="${timeMax}"`,
      pageSize: "100",
    });
    if (pageToken) q.set("pageToken", pageToken);
    const data = await apiGetJson(`${MEET_BASE}/v2/conferenceRecords?${q}`, token);
    out.push(...safeArr(data.conferenceRecords).map(safeObj));
    pageToken = safeStr(data.nextPageToken);
  } while (pageToken);
  return out;
}

export async function getSpace(token: string, spaceName: string): Promise<Record<string, unknown>> {
  if (!spaceName) return {};
  try {
    return await apiGetJson(`${MEET_BASE}/v2/${encodePath(spaceName)}`, token);
  } catch {
    return {};
  }
}

export async function listSmartNotes(
  token: string,
  conferenceRecordName: string,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let pageToken: string | undefined;
  const base = `${MEET_BASE}/v2/${encodePath(conferenceRecordName)}/smartNotes`;
  do {
    const q = new URLSearchParams({ pageSize: "100" });
    if (pageToken) q.set("pageToken", pageToken);
    const data = await apiGetJson(`${base}?${q}`, token);
    out.push(...safeArr(data.smartNotes).map(safeObj));
    pageToken = safeStr(data.nextPageToken);
  } while (pageToken);
  return out;
}

export async function exportNoteText(token: string, documentId: string): Promise<string> {
  const q = new URLSearchParams({ mimeType: "text/plain" });
  return apiGetText(`${DRIVE_BASE}/files/${encodeURIComponent(documentId)}/export?${q}`, token, "text/plain");
}

export async function listCalendarEvents(
  token: string,
  calendarId: string,
  timeMin: string,
  timeMax: string,
): Promise<CalEvent[]> {
  const out: CalEvent[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: "true",
      showDeleted: "false",
      maxResults: "250",
    });
    if (pageToken) q.set("pageToken", pageToken);
    const data = await apiGetJson(
      `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${q}`,
      token,
    );
    out.push(...safeArr(data.items).map((e) => safeObj(e) as CalEvent));
    pageToken = safeStr(data.nextPageToken);
  } while (pageToken);
  return out;
}

// --- correlation (guide section 5) ----------------------------------------

function intervalScore(
  ev: CalEvent,
  actualStart: Date | null,
  actualEnd: Date | null,
): { overlap: number; delta: number } {
  const evS = parseIso(ev.start?.dateTime);
  const evE = parseIso(ev.end?.dateTime);
  if (!evS || !evE || !actualStart || !actualEnd) return { overlap: 0, delta: 0 };
  const overlap = actualStart < evE && evS < actualEnd ? 30 : 0;
  const delta = Math.abs(actualStart.getTime() - evS.getTime()) <= 15 * 60 * 1000 ? 20 : 0;
  return { overlap, delta };
}

/**
 * Score candidate Calendar events. `accountEmail` is the authenticated user
 * (organizer OR admitted participant). Returns status + score + best event.
 */
export function correlate(
  meetingCode: string,
  documentId: string,
  accountEmail: string,
  actualStart: Date | null,
  actualEnd: Date | null,
  events: CalEvent[],
): CorrelationResult {
  let best: { score: number; event: CalEvent } | null = null;
  let second: { score: number; event: CalEvent } | null = null;

  for (const ev of events) {
    let score = 0;
    if (safeArr(ev.attachments).some((a) => safeObj(a).fileId === documentId)) score += 200;
    if (meetingCode && safeObj(ev.conferenceData).conferenceId === meetingCode) score += 100;

    const evOrg = safeStr(safeObj(ev.organizer).email);
    const evAttendees = new Set(
      safeArr(ev.attendees)
        .map((a) => safeStr(safeObj(a).email))
        .filter((x): x is string => !!x),
    );
    if (accountEmail) {
      if (evOrg === accountEmail) score += 40;
      else if (evAttendees.has(accountEmail)) score += 10;
    }

    const { overlap, delta } = intervalScore(ev, actualStart, actualEnd);
    score += overlap + delta;

    const cand = { score, event: ev };
    if (!best || cand.score > best.score) {
      second = best;
      best = cand;
    } else if (!second || cand.score > second.score) {
      second = cand;
    }
  }

  if (!best || best.score === 0) return { status: "UNMATCHED", score: 0, event: null };
  const marginOk = !second || best.score - second.score >= 30;
  if (best.score >= 150 && marginOk) return { status: "MATCHED", score: best.score, event: best.event };
  return { status: "REVIEW", score: best.score, event: best.event };
}

// --- capture pipeline -----------------------------------------------------

async function processConferenceRecord(
  token: string,
  cfg: OAuthConfig,
  cr: Record<string, unknown>,
  events: CalEvent[],
): Promise<NoteRecord[]> {
  const spaceName = safeStr(cr.space) ?? "";
  const crName = safeStr(cr.name) ?? "";
  const space = await getSpace(token, spaceName);
  const meetingCode = safeStr(space.meetingCode) ?? "";
  const actualStart = parseIso(safeStr(cr.startTime));
  const actualEnd = parseIso(safeStr(cr.endTime));
  const accountEmail = cfg.email ?? "";
  const now = new Date().toISOString();
  const notes: NoteRecord[] = [];

  for (const sn of await listSmartNotes(token, crName)) {
    if (safeStr(sn.state) !== "FILE_GENERATED") continue;
    const dest = safeObj(sn.docsDestination);
    const documentId = safeStr(dest.document);
    if (!documentId) continue;

    let content: string;
    try {
      content = await exportNoteText(token, documentId);
    } catch (e) {
      process.stderr.write(`WARN: export failed for ${documentId} (${errMsg(e)})\n`);
      continue;
    }

    const { status, score, event } = correlate(
      meetingCode,
      documentId,
      accountEmail,
      actualStart,
      actualEnd,
      events,
    );
    const ev = event ?? {};
    const attendees = safeArr(ev.attendees)
      .map((a) => safeStr(safeObj(a).email))
      .filter((x): x is string => !!x);

    notes.push({
      id: safeStr(sn.name) ?? `${crName}/smartNotes/${documentId}`,
      meeting_code: meetingCode,
      space_name: spaceName,
      conference_record: crName,
      actual_start: safeStr(cr.startTime),
      actual_end: safeStr(cr.endTime),
      document_id: documentId,
      doc_url: safeStr(dest.exportUri),
      content_hash: "sha256:" + sha256Hex(content),
      content,
      title: ev.summary,
      organizer: safeStr(safeObj(ev.organizer).email),
      attendees,
      event_id: ev.id,
      ical_uid: ev.iCalUID,
      scheduled_start: ev.start?.dateTime,
      scheduled_end: ev.end?.dateTime,
      corr_status: status,
      corr_score: score,
      state: "new",
      first_seen: now,
      last_synced: now,
    });
  }
  return notes;
}

export interface SyncOptions {
  days: number;
  all: boolean;
  since?: string;
}

export async function runSync(
  dirs: Dirs,
  opts: SyncOptions,
  overrides: AuthOverrides = {},
): Promise<{ batch: SyncBatch; store: Store }> {
  const { token, cfg } = await getAccessToken(dirs, overrides);
  const store = loadStore(dirs);
  const now = new Date();

  let sinceDate: Date;
  if (opts.since) {
    const d = parseIso(opts.since);
    if (!d) throw new Error(`invalid --since timestamp: ${opts.since}`);
    sinceDate = d;
  } else if (opts.all) {
    sinceDate = new Date(now.getTime() - opts.days * 86400000);
  } else if (store.checkpoint.lastSyncTo) {
    sinceDate = parseIso(store.checkpoint.lastSyncTo) ?? new Date(now.getTime() - opts.days * 86400000);
  } else {
    sinceDate = new Date(now.getTime() - opts.days * 86400000);
  }

  const timeMin = toUtcZ(sinceDate);
  const timeMax = toUtcZ(now);
  const accountEmail = cfg.email ?? "";
  const calendarId = cfg.calendar_id || accountEmail || "primary";

  let events: CalEvent[] = [];
  try {
    events = await listCalendarEvents(token, calendarId, timeMin, timeMax);
  } catch (e) {
    process.stderr.write(`WARN: calendar fetch failed, correlating without it (${errMsg(e)})\n`);
  }

  const records = await listConferenceRecords(token, timeMin, timeMax);
  const newIds: string[] = [];
  for (const cr of records) {
    const captured = await processConferenceRecord(token, cfg, cr, events);
    for (const note of captured) {
      if (upsertNote(store, note)) newIds.push(note.id);
    }
  }

  store.checkpoint.lastSyncTo = now.toISOString();
  saveStore(dirs, store);

  const items = newIds
    .map((id) => store.notes[id])
    .filter((n): n is NoteRecord => !!n)
    .map(publicItem);

  return {
    batch: { syncedAt: now.toISOString(), window: { from: timeMin, to: timeMax }, newCount: items.length, items },
    store,
  };
}

export async function runCheck(dirs: Dirs, overrides: AuthOverrides = {}): Promise<number> {
  const { token, cfg } = await getAccessToken(dirs, overrides);
  const now = new Date();
  const timeMax = toUtcZ(now);
  const timeMin = toUtcZ(new Date(now.getTime() - 86400000));
  let problems = 0;

  try {
    const recs = await listConferenceRecords(token, timeMin, timeMax);
    console.log(`Meet API:      OK (${recs.length} conference records in last 24h)`);
  } catch (e) {
    problems++;
    console.log(`Meet API:      FAIL (${errMsg(e)})`);
  }

  const accountEmail = cfg.email ?? "";
  const calendarId = cfg.calendar_id || accountEmail || "primary";
  try {
    const evs = await listCalendarEvents(token, calendarId, timeMin, timeMax);
    console.log(`Calendar API:  OK (${evs.length} events, calendar=${calendarId})`);
  } catch (e) {
    problems++;
    console.log(`Calendar API:  FAIL (${errMsg(e)})`);
  }

  if (!accountEmail) {
    console.log("WARNING: no 'email' in oauth.json; correlation account unknown.");
  }
  return problems > 0 ? 1 : 0;
}
