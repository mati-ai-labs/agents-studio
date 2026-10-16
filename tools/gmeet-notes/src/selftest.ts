/** Offline self-test — no Google account needed. Runs fully in memory. */

import { correlate } from "./core.js";
import {
  emptyStore,
  getNoteBySubstring,
  markProcessed,
  publicItem,
  searchNotes,
  upsertNote,
  type Store,
} from "./storage.js";
import type { CalEvent, NoteRecord } from "./types.js";

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? "ok   " : "FAIL ") + msg);
  if (!cond) failures++;
}

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
    content: "Discussed the roadmap. Action item: draft the launch plan.",
    title: "Weekly delivery review",
    organizer: "boss@co.com",
    attendees: ["me@co.com", "boss@co.com"],
    event_id: "EV1",
    ical_uid: "ical1",
    scheduled_start: "2026-07-21T09:00:00Z",
    scheduled_end: "2026-07-21T10:00:00Z",
    corr_status: "MATCHED",
    corr_score: 160,
    state: "new",
    first_seen: "2026-07-21T14:00:00Z",
    last_synced: "2026-07-21T14:00:00Z",
    ...over,
  };
}

export function runSelftest(): number {
  const store: Store = emptyStore();

  // upsert + idempotency
  const n1 = makeNote("conferenceRecords/CR1/smartNotes/SN1");
  check(upsertNote(store, n1) === true, "first insert reported new");
  check(upsertNote(store, n1) === false, "identical re-insert not reported new");

  // payload shape
  const item = publicItem(store.notes[n1.id]);
  check(item.meetingCode === "abc-defg-hij", "payload meetingCode");
  check(item.smartNote.documentId === "DOC123", "payload documentId");
  check(item.correlation.status === "MATCHED", "payload correlation status");
  check(item.calendar.organizer === "boss@co.com", "payload organizer");
  check(item.content.includes("roadmap"), "payload content present");

  // correlation scoring
  const events: CalEvent[] = [
    {
      id: "EV1",
      organizer: { email: "boss@co.com" },
      attendees: [{ email: "me@co.com" }, { email: "boss@co.com" }],
      start: { dateTime: "2026-07-21T09:00:00Z" },
      end: { dateTime: "2026-07-21T10:00:00Z" },
      conferenceData: { conferenceId: "abc-defg-hij" },
      attachments: [{ fileId: "DOC123" }],
    },
  ];
  const on = new Date("2026-07-21T09:02:00Z");
  const end = new Date("2026-07-21T09:58:00Z");
  const late = new Date("2026-07-21T09:31:00Z");
  const lateEnd = new Date("2026-07-21T10:20:00Z");
  const far = new Date("2026-01-01T09:00:00Z");
  const farEnd = new Date("2026-01-01T09:58:00Z");

  const org = correlate("abc-defg-hij", "DOC123", "boss@co.com", on, end, events);
  check(org.status === "MATCHED" && org.score === 390, `organizer + attachment -> MATCHED 390 (got ${org.status}/${org.score})`);
  const part = correlate("abc-defg-hij", "OTHER", "me@co.com", on, end, events);
  check(part.status === "MATCHED" && part.score === 160, `participant on-time -> MATCHED 160 (got ${part.status}/${part.score})`);
  const partLate = correlate("abc-defg-hij", "OTHER", "me@co.com", late, lateEnd, events);
  check(partLate.status === "REVIEW" && partLate.score === 140, `participant late start -> REVIEW 140 (got ${partLate.status}/${partLate.score})`);
  const none = correlate("zzz", "OTHER", "x@y.com", far, farEnd, events);
  check(none.status === "UNMATCHED" && none.score === 0, `no signal -> UNMATCHED 0 (got ${none.status}/${none.score})`);

  // search
  const hits = searchNotes(store, "launch plan", 10);
  check(hits.length === 1 && hits[0].note.id === n1.id, "search finds the note");

  // get by substring
  check(getNoteBySubstring(store, "SN1")?.id === n1.id, "get by substring id");

  // mark processed
  check(markProcessed(store, ["SN1"]) === 1, "mark-processed count");
  check(store.notes[n1.id].state === "processed", "note marked processed");

  console.log("");
  if (failures > 0) {
    console.log(`SELFTEST FAILED (${failures} check(s))`);
    return 1;
  }
  console.log("SELFTEST PASSED");
  return 0;
}
