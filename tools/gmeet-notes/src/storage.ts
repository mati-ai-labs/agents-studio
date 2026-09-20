/** Dependency-free note store: JSON file, atomic writes, ranked text search. */

import { readFileSync } from "node:fs";
import { atomicWriteJson, storePath, type Dirs } from "./config.js";
import type { NoteRecord, PublicItem } from "./types.js";
import { nowIso } from "./util.js";

export interface Store {
  checkpoint: { lastSyncTo?: string };
  notes: Record<string, NoteRecord>;
}

export function emptyStore(): Store {
  return { checkpoint: {}, notes: {} };
}

export function loadStore(dirs: Dirs): Store {
  try {
    const raw = JSON.parse(readFileSync(storePath(dirs), "utf8")) as Partial<Store>;
    return {
      checkpoint: raw.checkpoint && typeof raw.checkpoint === "object" ? raw.checkpoint : {},
      notes: raw.notes && typeof raw.notes === "object" ? (raw.notes as Store["notes"]) : {},
    };
  } catch {
    return emptyStore();
  }
}

export function saveStore(dirs: Dirs, store: Store): void {
  atomicWriteJson(storePath(dirs), store);
}

/**
 * Insert or update a note. Returns true if the note is new or its content
 * changed (i.e. it should be surfaced to the routine).
 */
export function upsertNote(store: Store, note: NoteRecord): boolean {
  const existing = store.notes[note.id];
  const now = nowIso();
  if (existing && existing.content_hash === note.content_hash) {
    existing.last_synced = now;
    return false;
  }
  store.notes[note.id] = {
    ...note,
    state: existing?.state ?? "new",
    processed_at: existing?.processed_at,
    first_seen: existing?.first_seen ?? now,
    last_synced: now,
  };
  return true;
}

/** Find a note whose id contains the given substring (shortest id wins). */
export function getNoteBySubstring(store: Store, id: string): NoteRecord | undefined {
  let best: NoteRecord | undefined;
  for (const note of Object.values(store.notes)) {
    if (note.id.includes(id) && (!best || note.id.length < best.id.length)) {
      best = note;
    }
  }
  return best;
}

/** Mark notes whose id contains any of the given substrings as processed. */
export function markProcessed(store: Store, ids: string[]): number {
  const now = nowIso();
  let count = 0;
  for (const note of Object.values(store.notes)) {
    if (ids.some((raw) => note.id.includes(raw))) {
      note.state = "processed";
      note.processed_at = now;
      count++;
    }
  }
  return count;
}

export interface ListOptions {
  from?: string;
  to?: string;
  limit: number;
}

export function sortedNotes(store: Store, opts: ListOptions): NoteRecord[] {
  const key = (n: NoteRecord): string => n.actual_start ?? n.first_seen;
  let notes = Object.values(store.notes);
  if (opts.from) notes = notes.filter((n) => key(n) >= opts.from!);
  if (opts.to) notes = notes.filter((n) => key(n) <= opts.to!);
  notes.sort((a, b) => key(b).localeCompare(key(a)));
  return notes.slice(0, opts.limit);
}

export function publicItem(note: NoteRecord): PublicItem {
  return {
    id: note.id,
    meetingCode: note.meeting_code,
    title: note.title,
    calendar: {
      eventId: note.event_id,
      iCalUID: note.ical_uid,
      summary: note.title,
      organizer: note.organizer,
      attendees: note.attendees,
      scheduledStart: note.scheduled_start,
      scheduledEnd: note.scheduled_end,
    },
    meet: {
      space: note.space_name,
      conferenceRecord: note.conference_record,
      actualStart: note.actual_start,
      actualEnd: note.actual_end,
    },
    smartNote: {
      name: note.id,
      documentId: note.document_id,
      state: "FILE_GENERATED",
      docUrl: note.doc_url,
      contentHash: note.content_hash,
    },
    content: note.content,
    correlation: { status: note.corr_status, score: note.corr_score },
    firstSeen: note.first_seen,
  };
}

// --- search ---------------------------------------------------------------

export interface SearchHit {
  note: NoteRecord;
  score: number;
  snippet: string;
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

function makeSnippet(content: string, terms: string[]): string {
  const lower = content.toLowerCase();
  let best = -1;
  let bestTerm = "";
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (best < 0 || i < best)) {
      best = i;
      bestTerm = t;
    }
  }
  const flat = content.replace(/\n/g, " ");
  if (best < 0) return flat.slice(0, 160);
  const start = Math.max(0, best - 60);
  const end = Math.min(content.length, best + bestTerm.length + 100);
  const marked =
    content.slice(start, best) +
    ">>>" +
    content.slice(best, best + bestTerm.length) +
    "<<<" +
    content.slice(best + bestTerm.length, end);
  return (start > 0 ? "…" : "") + marked.replace(/\n/g, " ") + (end < content.length ? "…" : "");
}

/**
 * Ranked full-text-ish search over cached notes. Title matches weigh more than
 * body matches; an exact-phrase match gets a bonus. Zero dependencies.
 */
export function searchNotes(store: Store, query: string, limit: number): SearchHit[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const phrase = query.trim().toLowerCase();
  const multiWord = terms.length > 1;
  const hits: SearchHit[] = [];
  for (const note of Object.values(store.notes)) {
    const title = (note.title ?? "").toLowerCase();
    const content = (note.content ?? "").toLowerCase();
    let score = 0;
    for (const t of terms) {
      score += countOccurrences(title, t) * 5;
      score += countOccurrences(content, t);
    }
    // Exact-phrase bonus only for genuine multi-word phrases, in title or body.
    if (multiWord && (content.includes(phrase) || title.includes(phrase))) score += 5;
    if (score > 0) {
      hits.push({ note, score, snippet: makeSnippet(note.content, terms) });
    }
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      (b.note.actual_start ?? "").localeCompare(a.note.actual_start ?? ""),
  );
  return hits.slice(0, limit);
}
