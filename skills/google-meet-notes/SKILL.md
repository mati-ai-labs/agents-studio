---
name: google-meet-notes
description: >
  Capture and query Google Meet "Take notes with Gemini" Smart Notes via the
  gmeet-notes CLI (npm package, zero runtime dependencies). A routine runs
  `gmeet-notes sync --json` periodically to capture NEW notes since the last
  checkpoint, correlate each to its Google Calendar event, and emit a JSON batch
  the agent acts on (summaries, action items, follow-ups). Also supports ad-hoc
  search/list/get over a local cache. Use when the user asks about meeting
  notes, what was discussed, decisions or action items from Google Meet
  meetings, or wants notes captured automatically.
metadata:
  openclaw:
    requires:
      bins: [gmeet-notes]
---

# Google Meet Smart Notes

Capture + query Google Meet "Take notes with Gemini" notes via the `gmeet-notes`
CLI (npm). This skill is a thin guide around that CLI — the CLI is the single
source of truth.

## Install (one-time)

```bash
npm install -g gmeet-notes        # or run without installing: npx -y gmeet-notes <cmd>
```

Requires Node.js >= 18. Config + cache live under `~/.config/gmeet-notes/` and
`~/.cache/gmeet-notes/` (override both with `MEETNOTES_HOME`).

## Auth setup (one-time)

1. In a GCP project enable the **Google Meet API**, **Google Calendar API**, and
   **Google Drive API**.
2. Configure the OAuth consent screen and add the account as a **test user**
   (External app). Scopes: `meetings.space.readonly`, `calendar.events.readonly`,
   `drive.meet.readonly`.
3. Create an OAuth **Web application** client and add authorized redirect URI
   `http://localhost:8765/`.
4. Run (opens a browser; uses PKCE):

   ```bash
   gmeet-notes auth setup --client-id <ID> --client-secret <SECRET> --email you@company.com
   ```

   `--email` must be a meeting **organizer OR an admitted participant** of the
   meetings you want notes from. Writes `~/.config/gmeet-notes/oauth.json` (0600).
5. Verify access (read-only):

   ```bash
   gmeet-notes check
   ```

## The capture-and-act routine

Run periodically (cron, `/loop`, or a scheduled agent task):

1. `gmeet-notes sync --json`
2. If `newCount` is 0, stop.
3. For each `items[]` entry, do the work the note implies, e.g. summarize and
   post to a channel/issue, extract action items and create tasks, or attach a
   summary to the related event/CRM record. Keep each action linked to the
   note's `id`, `meetingCode`, and `smartNote.documentId`; include
   `smartNote.docUrl` when sharing.
4. `gmeet-notes mark-processed <id> ...` for every note acted on (prevents
   reprocessing on the next run).

## Commands

| Command | Purpose |
|---|---|
| `sync [--json] [--days N] [--all] [--since ISO]` | Capture + correlate new notes. `--json` emits the batch the routine consumes. |
| `mark-processed ID... [--json]` | Record that notes were acted on (ids substring-matched). |
| `search "query" [--json] [--limit N]` | Full-text search over cached notes. |
| `list [--from ISO --to ISO --limit N --json]` | List cached notes (newest first; `*` = unprocessed). |
| `get <id> [--json]` | Full note text + metadata. |
| `stats [--json]` | Cache size, unprocessed count, last sync time. |
| `check` | Validate auth + Meet/Calendar access (read-only). |
| `selftest` | Offline test (no Google account needed). |
| `auth refresh` | Force-refresh the access token (use after a 401). |

## Sync payload shape

```json
{
  "syncedAt": "…", "window": {"from": "…", "to": "…"}, "newCount": 2,
  "items": [{
    "id": "conferenceRecords/…/smartNotes/…",
    "meetingCode": "abc-defg-hij",
    "title": "Weekly delivery review",
    "calendar": {"eventId": "…", "organizer": "…", "attendees": ["…"],
                 "scheduledStart": "…", "scheduledEnd": "…"},
    "meet": {"space": "spaces/…", "conferenceRecord": "conferenceRecords/…",
             "actualStart": "…", "actualEnd": "…"},
    "smartNote": {"documentId": "…", "state": "FILE_GENERATED",
                  "docUrl": "…", "contentHash": "sha256:…"},
    "content": "<plain-text note>",
    "correlation": {"status": "MATCHED", "score": 170}
  }]
}
```

`correlation.status`: `MATCHED` (auto-linked), `REVIEW` (ambiguous — verify
before acting), `UNMATCHED` (ad-hoc meeting, no Calendar event).

## Auth & token refresh

The CLI refreshes the access token automatically. **On a 401:**
`gmeet-notes auth refresh`, then retry. If refresh fails (revoked token),
re-run `auth setup`.

> **Test-mode caveat:** External OAuth apps in Google's "test mode" issue
> refresh tokens that expire every **7 days** — re-run `auth setup` weekly, or
> use a Workspace **Internal** app / a verified app to avoid this.

## Notes & limits

- **Access is per-participant:** notes are visible to the organizer and any
  participant who was *admitted* (actually joined) — not invitees who never joined.
- Only notes in state `FILE_GENERATED` are captured; in-progress notes are picked
  up on a later sync.
- "Take notes with Gemini" requires an eligible Workspace edition or Google AI plan.
- Export is plain text (minimum-privilege `drive.meet.readonly`).
- Meet `ConferenceRecord`s expire 30 days after a call, so notes are cached
  locally on first capture; `sync` is idempotent (only emits the delta).
