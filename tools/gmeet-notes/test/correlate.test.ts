import assert from "node:assert/strict";
import test from "node:test";
import { correlate } from "../src/core.js";
import type { CalEvent } from "../src/types.js";

const baseEvent: CalEvent = {
  id: "EV1",
  organizer: { email: "boss@co.com" },
  attendees: [{ email: "me@co.com" }, { email: "boss@co.com" }],
  start: { dateTime: "2026-07-21T09:00:00Z" },
  end: { dateTime: "2026-07-21T10:00:00Z" },
  conferenceData: { conferenceId: "abc-defg-hij" },
  attachments: [{ fileId: "DOC123" }],
};

const on = new Date("2026-07-21T09:02:00Z");
const end = new Date("2026-07-21T09:58:00Z");

test("organizer with matching attachment scores 390 -> MATCHED", () => {
  const r = correlate("abc-defg-hij", "DOC123", "boss@co.com", on, end, [baseEvent]);
  assert.equal(r.status, "MATCHED");
  assert.equal(r.score, 200 + 100 + 40 + 30 + 20);
  assert.equal(r.event?.id, "EV1");
});

test("participant on-time scores 160 -> MATCHED", () => {
  const r = correlate("abc-defg-hij", "OTHER", "me@co.com", on, end, [baseEvent]);
  assert.equal(r.status, "MATCHED");
  assert.equal(r.score, 100 + 10 + 30 + 20);
});

test("participant with a late start scores 140 -> REVIEW (no false auto-link)", () => {
  const late = new Date("2026-07-21T09:31:00Z");
  const lateEnd = new Date("2026-07-21T10:20:00Z");
  const r = correlate("abc-defg-hij", "OTHER", "me@co.com", late, lateEnd, [baseEvent]);
  assert.equal(r.status, "REVIEW");
  assert.equal(r.score, 100 + 10 + 30);
});

test("no shared signal -> UNMATCHED 0", () => {
  const far = new Date("2026-01-01T09:00:00Z");
  const farEnd = new Date("2026-01-01T09:58:00Z");
  const r = correlate("zzz", "OTHER", "x@y.com", far, farEnd, [baseEvent]);
  assert.equal(r.status, "UNMATCHED");
  assert.equal(r.score, 0);
  assert.equal(r.event, null);
});

test("equal top candidates fail the runner-up margin -> REVIEW", () => {
  const twin: CalEvent = { ...baseEvent, id: "EV2" };
  const r = correlate("abc-defg-hij", "OTHER", "me@co.com", on, end, [baseEvent, twin]);
  assert.equal(r.status, "REVIEW");
});

test("malformed events do not throw", () => {
  const junk = [{}, { start: "nope", attendees: "nope" }] as unknown as CalEvent[];
  const r = correlate("abc", "d", "a@b.com", on, end, junk);
  assert.equal(r.status, "UNMATCHED");
});
