# gmeet-notes

Capture, correlate, and query Google Meet **"Take notes with Gemini"** Smart
Notes from the command line. Built for agent routines: run `sync` periodically
to capture **new** notes since the last checkpoint, each correlated to its
Google Calendar event, and emit a JSON batch to act on.

**Zero runtime dependencies.** Only Node built-ins (`fetch`, `node:crypto`,
`node:http`, `node:fs`). No supply chain to audit, no native builds, no
`postinstall` scripts.

## How it works

```
routine (cron / loop, every 15–60 min)
  -> gmeet-notes sync --json          # capture + correlate NEW notes
  -> your agent acts on each item      # summarize, extract actions, file tasks…
  -> gmeet-notes mark-processed <id>…  # prevent reprocessing
```

The pipeline (Meet API v2 → Drive plain-text export → Calendar correlation) runs
inside the CLI. Notes are cached locally because Meet `ConferenceRecord`s expire
**30 days** after a call. `sync` is idempotent: by default it only emits notes
captured since the last checkpoint.

## Install

```bash
npm install -g gmeet-notes      # global
# or run without installing:
npx gmeet-notes --help
```

Requires Node.js ≥ 18.

## Setup (one-time)

1. In a GCP project, enable the **Google Meet API**, **Google Calendar API**, and
   **Google Drive API**.
2. Configure the OAuth consent screen (Internal for your own Workspace org;
   otherwise External + add yourself as a test user).
3. Create an OAuth **Web application** client and add authorized redirect URI
   `http://localhost:8765/`.
4. Run the OAuth flow (opens a browser; uses PKCE + `state`):

   ```bash
   gmeet-notes auth setup \
     --client-id <CLIENT_ID> --client-secret <CLIENT_SECRET> \
     --email you@company.com
   ```

   `--email` should be an account that is the meeting **organizer or an admitted
   participant** of the meetings you want notes from. Credentials are written to
   `~/.config/gmeet-notes/oauth.json` with mode `0600`.

5. Verify access (read-only):

   ```bash
   gmeet-notes check
   ```

Scopes requested (minimum-privilege): `meetings.space.readonly`,
`calendar.events.readonly`, `drive.meet.readonly`.

## Commands

| Command | Purpose |
|---|---|
| `auth setup --client-id <id> --client-secret <secret> [--email <you>] [--port 8765]` | One-time OAuth (PKCE). |
| `auth refresh` | Force-refresh the access token. |
| `sync [--json] [--days N] [--all] [--since ISO]` | Capture + correlate new notes. `--json` emits the batch a routine consumes. |
| `list [--from ISO --to ISO --limit N --json]` | List cached notes (newest first; `*` = unprocessed). |
| `get <id> [--json]` | Full note text + metadata (id substring-matched). |
| `search <query> [--limit N --json]` | Full-text search over cached notes. |
| `mark-processed <id…> [--json]` | Mark notes as acted-on (prevents reprocessing). |
| `stats [--json]` | Cache size, unprocessed count, last sync time. |
| `check` | Validate auth + Meet/Calendar access (read-only). |
| `selftest` | Offline test (no Google account needed). |

Unknown flags are rejected. Set `MEETNOTES_HOME` to relocate config + cache
(otherwise XDG: `~/.config/gmeet-notes`, `~/.cache/gmeet-notes`).

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

`correlation.status` is `MATCHED` (auto-linked), `REVIEW` (ambiguous — verify
before acting), or `UNMATCHED` (ad-hoc meeting, no Calendar event).

## Notes & limits

- **Access is per-participant:** the Meet API exposes a meeting's Smart Notes to
  its organizer and to any participant who was *admitted* (actually joined) — not
  to invitees who never joined.
- Only notes in state `FILE_GENERATED` are captured; in-progress notes are picked
  up on a later sync.
- "Take notes with Gemini" requires an eligible Workspace edition or Google AI
  plan.
- Export is plain text (minimum-privilege). Structured Docs parsing would need an
  extra scope and is intentionally not used.

## Security

- **Zero runtime dependencies** — only Node built-ins; nothing to audit.
- **OAuth:** authorization-code flow with **PKCE (S256)** and a `state` check
  (CSRF protection). The callback server binds to **127.0.0.1 only** and times
  out after 5 minutes.
- **Secrets:** `oauth.json` is written atomically with mode `0600`. Tokens are
  never logged; errors never include credentials.
- **Untrusted input:** Google API responses are shape-validated before use. Query
  parameters are built with `URLSearchParams`; resource paths are
  segment-encoded. Note content is stripped of ANSI/control characters before
  human-facing terminal output (raw data preserved in JSON output and on disk).
- **No shell-outs** except a best-effort, array-form browser open with a URL this
  tool constructs.

## Development

```bash
npm install        # dev deps only (typescript)
npm run build      # tsc -> dist/
npm test           # build + node:test unit tests
npm run selftest   # offline CLI self-test
```

## License

MIT
