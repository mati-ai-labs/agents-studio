# Two-way Slack integration

This doc covers Paperclip's two-way Slack integration: linking Slack channels to Paperclip agents so that `@Agent Studio` mentions create issues, thread replies become issue comments, and the agent's progress and completion messages post back into the same Slack thread.

## What's implemented

| Surface                            | Where                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| Slack OAuth (workspace connect)    | `POST /api/connectors/slack/connect` → `GET /api/connectors/slack/callback`             |
| Inbound event verification         | `POST /api/connectors/slack/events` (signed via `SLACK_SIGNING_SECRET`)                |
| Inbound app mention / thread reply | `server/src/services/slack-inbound-handler.ts`, `slack-issue-ingest.ts`                |
| Channel → agent routing            | `POST|PUT|PATCH /api/connectors/slack/channel-routes`, `DELETE /…/{channelId}`         |
| Self-serve setup diagnostics       | `GET /api/connectors/slack/events-info`                                                |
| Slash command (`/paperclip …`)     | `POST /api/connectors/slack/slash-commands` (channel mode switch + status)             |
| Outbound delivery worker           | Auto-started in `server/src/app.ts` (acks, progress, completion, errors — at-least-once) |
| Durable tables                     | `slack_channel_routes`, `slack_thread_bindings`, `slack_event_deliveries`, `slack_outbound_deliveries` (4 new) |
| Issue ↔ Slack link                 | `issues.originKind='slack_thread'` partial unique index + `issue_comments.external*` columns |

Five commits on `feature/slack` (HEAD `1a1ed152`):

```
b5b23fd1  feat: add Slack two-way integration schema (issue bindings, event deliveries, outbound queue)
606b85bb  feat(slack): add signed events and inbound issue bridge
fd50118d  feat(slack): add company-scoped channel route API
6edb8702  feat(slack): add durable outbound delivery and progress queue
1a1ed152  feat(slack): add slash command modes and setup docs
```

## Environment

Set on the Paperclip server (`.paperclip/.env` for the local dev runner, or whatever manages the deployment env):

| Var                       | Required?         | Purpose                                                                                      |
| ------------------------- | ----------------- | -------------------------------------------------------------------------------------------- |
| `SLACK_CLIENT_ID`         | Yes               | Slack app's OAuth client id                                                                   |
| `SLACK_CLIENT_SECRET`     | Yes               | Slack app's OAuth client secret (bot token is exchanged via the OAuth flow, not env)         |
| `SLACK_SIGNING_SECRET`    | Yes (prod)        | Verifies `X-Slack-Signature` on inbound events and slash commands                            |
| `SLACK_APP_ID`            | Recommended       | Rejects inbound events from a different Slack app (defense in depth)                         |
| `PAPERCLIP_PUBLIC_URL`    | Yes               | Externally reachable HTTPS origin Slack will POST to. **No trailing slash.** Used to build `events` / `slash-commands` URLs and issue links in Slack messages |

Local dev (`.paperclip/.env`) already carries `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`. The remaining vars (`SLACK_SIGNING_SECRET`, `SLACK_APP_ID`, `PAPERCLIP_PUBLIC_URL`) need to be added before the Slack dashboard can talk to this server.

## Slack app dashboard

Create a Slack app (or use the existing one) with these scopes:

- `app_mentions:read`
- `channels:history`
- `channels:read`
- `chat:write`
- `chat:write.public`
- `users:read`
- `team:read`

Configure the following on the Slack app:

| Setting                     | Value                                                                       |
| --------------------------- | --------------------------------------------------------------------------- |
| OAuth Redirect URL          | `https://<PAPERCLIP_PUBLIC_URL>/api/connectors/slack/callback`              |
| Event Subscriptions URL     | `https://<PAPERCLIP_PUBLIC_URL>/api/connectors/slack/events`                |
| Slash Command Request URL   | `https://<PAPERCLIP_PUBLIC_URL>/api/connectors/slack/slash-commands`        |
| Slash Command               | Command: `/paperclip`, Short Description, Usage Hint: `triage\|working\|paused\|status` |
| Bot Events                  | `app_mention`, `message.channels`                                            |
| App ID                      | Copy "App ID" from **Basic Information** into `SLACK_APP_ID`                 |
| Signing Secret              | Copy from **Basic Information → App Credentials → Signing Secret** into `SLACK_SIGNING_SECRET` |

After changing scopes or the slash command, **reinstall the app to the workspace**. The new scopes are not granted until reinstall completes.

## OAuth install

From the Paperclip UI, open the Slack connector and click **Connect** — this redirects through `POST /api/connectors/slack/connect` to Slack's OAuth consent screen, then back to `GET /api/connectors/slack/callback`, which exchanges the code for a bot token and persists the connector with `status='connected'`.

If scopes changed after a previous install, the existing token won't carry the new scopes — reinstall from the Slack app dashboard, then repeat the connect flow in Paperclip so the new bot token is stored.

## Channel routing

Once the workspace is connected, link a public channel to an agent:

```bash
curl -X POST 'https://<PAPERCLIP_PUBLIC_URL>/api/connectors/slack/channel-routes?companyId=<COMPANY_ID>' \
  -H 'Cookie: <board session>' \
  -H 'Content-Type: application/json' \
  -d '{
    "channelId": "C01ABCD2EFG",
    "assigneeAgentId": "<AGENT_UUID>",
    "enabled": true
  }'
```

Validation: the channel must be a public channel that the bot has been invited to. The handler reads the bot's `channels.list`, finds the channel by id, and refuses anything that isn't a joined public channel (returns 422).

Other endpoints (all require board auth + `companyId`):

| Method   | Path                                                | Purpose                          |
| -------- | --------------------------------------------------- | -------------------------------- |
| `GET`    | `/api/connectors/slack/channel-routes`              | List routes for the company      |
| `PUT`    | `/api/connectors/slack/channel-routes/:channelId`   | Upsert route for a known channel |
| `PATCH`  | `/api/connectors/slack/channel-routes/:channelId`   | Same as PUT                      |
| `DELETE` | `/api/connectors/slack/channel-routes/:channelId`   | Remove the route                 |
| `GET`    | `/api/connectors/slack/events-info`                 | Diagnostic snapshot (URL, scopes, route count) |

## Slash command

After the slash command URL is configured and the app is reinstalled, `/paperclip` works in any channel the bot is in:

| Invocation                  | Effect                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `/paperclip triage`         | Sets the channel mode to **triage** — new `@Agent Studio` mentions create issues (default) |
| `/paperclip working`        | Sets the channel mode to **working** — same as triage for issue creation               |
| `/paperclip paused`         | Pauses the channel — new mentions are acknowledged but no new issues are created       |
| `/paperclip status`         | Reads back the current mode for the channel                                           |

Responses are ephemeral (visible only to the user who ran the command).

## Two-way mapping rules

- **First `@Agent Studio` mention in a channel** → a new Paperclip issue is created (`originKind='slack_thread'`, `originId=<workspace>:<channel>:<threadTs>`). Subsequent replies in the same Slack thread become `IssueComment`s on that issue (`externalSource='slack_thread'`).
- **Replies inside an existing thread** → comment on the bound issue (deduped by `externalId`).
- **`message.channels`** events without a `thread_ts` are ignored (no standalone messages, only thread context).
- **Dedupe** is at three layers: `slack_event_deliveries.event_id` (Slack event id replay), `slack_event_deliveries (workspace, channel, message_ts)` partial unique (per-message), and `issues (companyId, originKind, originId)` partial unique (issue creation race).
- **Outbound** messages (ack / progress / completion / error) are queued in `slack_outbound_deliveries` and drained by the worker started in `app.ts`. Dedupe key prevents duplicate posts on retry.

## Local dev: testing end-to-end

The Slack dashboard needs a publicly reachable HTTPS URL pointing at this Paperclip server, so local dev requires a tunnel:

1. Confirm Paperclip server is up and healthy: `curl http://127.0.0.1:3101/api/health` (the dev runner binds `127.0.0.1:3101` by default).
2. Start a tunnel that forwards to `http://127.0.0.1:3101`:
   - `ngrok http 3101` → copy the `https://…ngrok-free.app` URL, **or**
   - `cloudflared tunnel --url http://127.0.0.1:3101` → copy the `https://…trycloudflare.com` URL.
3. Add to `.paperclip/.env`:
   ```
   PAPERCLIP_PUBLIC_URL=https://<your-tunnel-host>
   SLACK_SIGNING_SECRET=<from Slack app dashboard>
   SLACK_APP_ID=<from Slack app dashboard>
   ```
4. Restart the Paperclip server so the new env is picked up. The dev runner doesn't hot-reload env.
5. Update the Slack app dashboard's OAuth Redirect URL, Event Subscriptions URL, and Slash Command URL to use the tunnel host.
6. Reinstall the Slack app to the workspace (required after scope / URL changes).
7. Run the OAuth connect flow in Paperclip UI to persist the new bot token.
8. Invite `@Agent Studio` to the target public channel, then POST a channel route (see above).
9. Send `@Agent Studio hello` in the channel — the inbound event hits `/api/connectors/slack/events`, the issue is created, the ack posts back into the thread.

Slack redelivers events with the same `X-Slack-Request-Timestamp` window if the server times out, so a 200 from the events endpoint must be returned within ~3 s. The current handler persists to `slack_event_deliveries` first and responds 200 quickly, then kicks the worker.

## What's handled where

- **Paperclip side (this PR):** all of the above — code, schema, outbound worker, slash command, channel route API. No manual worker boot needed; the worker starts with the server.
- **Operator side (Aditya / Slack dashboard owner):** provisioning the Slack app, installing it, setting up the tunnel for dev, copying `SLACK_SIGNING_SECRET` and `SLACK_APP_ID` into `.paperclip/.env`, populating the channel routes via the API or the eventual UI.

No credentials are committed. `.paperclip/.env` is gitignored.
