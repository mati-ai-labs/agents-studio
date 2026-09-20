import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveDirs, storePath } from "../src/config.js";
import {
  emptyStore,
  getNoteBySubstring,
  loadStore,
  markProcessed,
  publicItem,
  saveStore,
  searchNotes,
  sortedNotes,
  upsertNote,
  type Store,
} from "../src/storage.js";
import type { NoteRecord } from "../src/types.js";

function makeNote(id: string, over: Partial<NoteRecord> = {}): NoteRecord {
  return {
    id,
    meeting_code: "abc-defg-hij",
    space_name: "spaces/SP1",
    conference_record: "conferenceRecords/CR1",
    actual_start: "2026-07-21T09:02:00Z",
    actual_end: "2026-07-21T09:58:00Z",
    document_id: "DOC123",
    doc_url: "https://docs.google.com/document/d/DOC123/view",
    content_hash: "sha256:" + id,
    content: "We discussed the roadmap and the launch plan.",
    title: "Weekly delivery review",
    organizer: "boss@co.com",
    attendees: ["me@co.com"],
    corr_status: "MATCHED",
    corr_score: 160,
    state: "new",
    first_seen: "2026-07-21T14:00:00Z",
    last_synced: "2026-07-21T14:00:00Z",
    ...over,
  };
}

test("upsert is idempotent by content hash", () => {
  const store: Store = emptyStore();
  const n = makeNote("a/SN1");
  assert.equal(upsertNote(store, n), true);
  assert.equal(upsertNote(store, n), false);
  // content change -> surfaced again
  assert.equal(upsertNote(store, { ...n, content: "changed", content_hash: "sha256:new" }), true);
});

test("save/load round-trips through a temp MEETNOTES_HOME", () => {
  const home = mkdtempSync(join(tmpdir(), "gn-"));
  process.env.MEETNOTES_HOME = home;
  try {
    const dirs = resolveDirs();
    const store = emptyStore();
    upsertNote(store, makeNote("a/SN1"));
    store.checkpoint.lastSyncTo = "2026-07-21T15:00:00Z";
    saveStore(dirs, store);

    const raw = readFileSync(storePath(dirs), "utf8");
    assert.ok(raw.includes("SN1"));

    const reloaded = loadStore(dirs);
    assert.ok(reloaded.notes["a/SN1"]);
    assert.equal(reloaded.checkpoint.lastSyncTo, "2026-07-21T15:00:00Z");
  } finally {
    rmSync(home, { recursive: true, force: true });
    delete process.env.MEETNOTES_HOME;
  }
});

test("loadStore returns empty store when file is missing or corrupt", () => {
  const home = mkdtempSync(join(tmpdir(), "gn-"));
  process.env.MEETNOTES_HOME = home;
  try {
    const dirs = resolveDirs();
    assert.deepEqual(loadStore(dirs).notes, {});
  } finally {
    rmSync(home, { recursive: true, force: true });
    delete process.env.MEETNOTES_HOME;
  }
});

test("search ranks title matches above body matches", () => {
  const store = emptyStore();
  upsertNote(store, makeNote("a/SN1", { title: "Roadmap planning", content: "nothing here" }));
  upsertNote(store, makeNote("a/SN2", { title: "Standup", content: "mentioned the roadmap briefly" }));
  const hits = searchNotes(store, "roadmap", 10);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].note.id, "a/SN1");
});

test("search returns empty for blank query", () => {
  const store = emptyStore();
  upsertNote(store, makeNote("a/SN1"));
  assert.deepEqual(searchNotes(store, "   ", 10), []);
});

test("mark-processed matches by substring", () => {
  const store = emptyStore();
  upsertNote(store, makeNote("conferenceRecords/C1/smartNotes/SN1"));
  assert.equal(markProcessed(store, ["SN1"]), 1);
  assert.equal(getNoteBySubstring(store, "SN1")?.state, "processed");
});

test("sortedNotes orders newest first and respects limits", () => {
  const store = emptyStore();
  upsertNote(store, makeNote("a/old", { actual_start: "2026-07-01T09:00:00Z" }));
  upsertNote(store, makeNote("a/new", { actual_start: "2026-07-20T09:00:00Z" }));
  const all = sortedNotes(store, { limit: 10 });
  assert.equal(all[0].id, "a/new");
  assert.equal(sortedNotes(store, { limit: 1 }).length, 1);
});

test("publicItem exposes the guide-shaped payload", () => {
  const item = publicItem(makeNote("a/SN1"));
  assert.equal(item.smartNote.state, "FILE_GENERATED");
  assert.equal(item.calendar.attendees.length, 1);
  assert.equal(typeof item.content, "string");
});
