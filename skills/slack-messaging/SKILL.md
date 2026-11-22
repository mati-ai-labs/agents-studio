---
name: slack-messaging
description: Read, post, react and run polls in the company Slack. Use when an issue points at Slack messages or threads, when work needs a human decision or approval that an issue comment alone will not reach, when you need a quick choice from people, or when asked to notify someone on Slack.
---

# Slack messaging

You can read and post in the company's Slack workspace through the Paperclip API: read channels and threads, post and tag people, react, edit or delete your own messages, and run polls whose votes come back to the issue. The server holds the Slack bot token; you never see it, and you never need it.

API base: `API="${PAPERCLIP_API_URL%/}"; API="${API%/api}"`. Auth: `-H "Authorization: Bearer $PAPERCLIP_API_KEY"`. Add `-H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID"` on the POST.

## When to post

Post when a specific person must act and an issue comment is not enough, for example:
- a decision, approval or review only a human can give
- missing access, credentials, data or a third-party setting
- a blocker you cannot clear yourself
- the user or issue explicitly asks you to notify someone on Slack

Do not post routine progress, "starting work" or "done" notes; issue comments and the existing Slack thread sync cover those. Do not re-ping the same person about the same thing: check the issue's activity for an earlier `slack.message_posted` first, and wait at least a few hours before a follow-up. You are limited to 20 messages per hour.

## Who to tag

1. If this company has an owners list (an "Owners" section in this skill or your AGENTS.md), use it first.
2. Otherwise read the members list and choose by title and name:
   `curl -sS "$API/api/companies/$PAPERCLIP_COMPANY_ID/slack/members" -H "Authorization: Bearer $PAPERCLIP_API_KEY"`
   Each member has `id`, `realName`, `displayName`, `title`, `timezone`.
3. Tag the one or two people who must act, not everyone who might care. If you cannot tell who owns it, tag nobody, say so in the message, and ask who should own it.

## Pick a channel

`curl -sS "$API/api/companies/$PAPERCLIP_COMPANY_ID/slack/channels" -H "Authorization: Bearer $PAPERCLIP_API_KEY"`

Use a channel with `canPost: true`, and prefer one with `repliesForwarded: true` (replies there come back to the issue). Prefer the channel the issue came from (if the issue came from Slack, reply in that thread with `threadTs`), then the owners list's channel, then the team's main channel. Never DM, and never post to a channel unrelated to the work.

## Post

```bash
curl -sS -f -X POST "$API/api/companies/$PAPERCLIP_COMPANY_ID/slack/messages" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d '{"channel":"#eng","mentionUserIds":["U0123ABCD"],"issueId":"'"$PAPERCLIP_TASK_ID"'","text":"Need your call: should coach notes be visible to admins? Blocking the notes API (LCH-31)."}'
```

- `channel`: channel id, `#name` or `name`.
- `mentionUserIds`: Slack user ids from the members list (max 10). The server turns them into real @mentions.
- `issueId`: always pass it when the message is about an issue. The server adds your name and the issue link, records the message on the issue, and links the Slack thread to the issue (see Replies).
- `threadTs` (optional): reply inside an existing thread.

Write the message so the person can act without opening anything: what you need, from whom, by when if it matters, and the one-line reason. Two or three sentences. No secrets, tokens, passwords or customer personal data.

After posting, add an issue comment naming who you tagged and why, so the issue shows it.

## Replies

When you pass `issueId`, the Slack thread is linked to that issue. Anyone who replies in the thread shows up as an issue comment (`From Slack user <name>: ...`) and you are woken to handle it, the same as a board comment. So:
- Do not poll Slack or ask people to comment on the issue instead; just wait for the reply to arrive as a comment.
- To answer them, post again with the same `issueId` and `threadTs` set to the `messageTs` you got back, so the conversation stays in one thread.
- Your issue comments are not copied into this thread. Only messages you post with this tool reach Slack.

The response's `replyTracking` tells you whether replies will come back: `active` means yes. Anything else (`bot_not_in_channel`, `private_channel_unsupported`, `thread_belongs_to_other_issue`, `not_bound`) comes with a `replyTrackingHint`; mention it in your issue comment so a human knows to check Slack.

## Read Slack

You can read any channel the bot is in. Use this whenever the issue points at Slack ("check the messages in the group", "see what X said", an issue created from a Slack mention).

1. **Find the issue's Slack thread.** Issues created from Slack say `Source: Slack <workspace>/<channel>/<ts>` in the description. Or list the threads linked to the issue:
   `curl -sS "$API/api/companies/$PAPERCLIP_COMPANY_ID/issues/$PAPERCLIP_TASK_ID/slack/threads" -H "Authorization: Bearer $PAPERCLIP_API_KEY"`
2. **Read the whole thread** (root message plus all replies, oldest first):
   `curl -sS "$API/api/companies/$PAPERCLIP_COMPANY_ID/slack/channels/<channel>/threads/<threadTs>" -H "Authorization: Bearer $PAPERCLIP_API_KEY"`
3. **Read recent channel messages** (top-level, newest first; a message with `replyCount > 0` has a thread you can read with step 2):
   `curl -sS "$API/api/companies/$PAPERCLIP_COMPANY_ID/slack/channels/<channel>/messages?limit=50" -H "Authorization: Bearer $PAPERCLIP_API_KEY"`
   Narrow by time with `oldest=<ts>` / `latest=<ts>`; page with `cursor=<nextCursor>` while `hasMore` is true.
4. **Read one message:** `GET .../slack/channels/<channel>/messages/<ts>` (works for thread replies too).

`<channel>` is a channel id (`C…`), `name` or `%23name`. Each message has `ts`, `threadTs`, `userId`, `userName`, `text`, `replyCount`, `files`, `reactions` and a `link` to open it in Slack. Text keeps Slack markup: `<@U123>` is a person (look the id up in the members list), `<#C123>` a channel.

If you get `422 not_in_channel`, the bot has not joined that channel. For a public channel, join it and retry:
`curl -sS -X POST "$API/api/companies/$PAPERCLIP_COMPANY_ID/slack/channels/<channel>/join" -H "Authorization: Bearer $PAPERCLIP_API_KEY"`
A private channel needs a human to invite the bot; say so on the issue.

Quote what you read in your issue comment (who said what, with the `link`) so the issue carries the context.

## React to a message

Acknowledge a message without posting: `:eyes:` when you start on it, `:white_check_mark:` when it's handled.

```bash
curl -sS -f -X POST "$API/api/companies/$PAPERCLIP_COMPANY_ID/slack/reactions" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" \
  -d '{"channel":"<channel>","ts":"<message ts>","name":"eyes"}'
```

Add `"remove": true` to take a reaction off.

## Edit or delete your own message

Only messages the Paperclip bot posted. Fix a mistake rather than posting a correction:

```bash
curl -sS -f -X PATCH "$API/api/companies/$PAPERCLIP_COMPANY_ID/slack/messages" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" \
  -d '{"channel":"<channel>","ts":"<messageTs>","text":"Corrected text"}'
curl -sS -f -X DELETE "$API/api/companies/$PAPERCLIP_COMPANY_ID/slack/messages?channel=<channel>&ts=<messageTs>" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

## Polls

Use a poll when you need a choice between known options from one or more people (a date, an approach, yes/no). People click a button in Slack; you get each vote back.

```bash
curl -sS -f -X POST "$API/api/companies/$PAPERCLIP_COMPANY_ID/slack/polls" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d '{"channel":"<channel>","issueId":"'"$PAPERCLIP_TASK_ID"'","question":"Which login fix do we ship?","options":["Patch Safari only","Rewrite the cookie flow"],"mentionUserIds":["U0123ABCD"],"closesInMinutes":240}'
```

- `options`: 2 to 10 short labels. `multiSelect: true` lets people pick several.
- `issueId` is required; `threadTs` posts the poll inside a thread; `mentionUserIds` tags who must vote.
- `closesInMinutes` (or `closesAt`, ISO time) closes it automatically. Polls count toward the 20 messages per hour.
- The response has `pollId`. Clicking again takes a vote back.

**Getting the answer back:** every vote arrives as an issue comment (`From Slack user <name> (poll vote): ...` with the running tally) and wakes you. Do not poll for results. When a deadline passes, a final "Slack poll closed" comment wakes you with the result. You can also read results or close it yourself:
- `GET $API/api/companies/$PAPERCLIP_COMPANY_ID/slack/polls/<pollId>` returns each option's `votes` and `voterIds`.
- `POST $API/api/companies/$PAPERCLIP_COMPANY_ID/slack/polls/<pollId>/close` once you have the answer you need.
- `GET $API/api/companies/$PAPERCLIP_COMPANY_ID/issues/$PAPERCLIP_TASK_ID/slack/polls` lists the issue's polls.

## Errors

- `422 not_in_channel`: the bot is not in that private channel; pick another or ask a human to invite it.
- `422 unknown_mention`: an id is not in the members list; re-read the list.
- `422 not_in_channel` while reading: join the public channel (`POST .../slack/channels/<channel>/join`) and retry.
- `422 missing_scope`: the Slack app needs a new permission (for example reactions or private-channel history). Say so on the issue; a human must reconnect Slack.
- `422 cant_update_message` / `cant_delete_message`: you can only change messages the bot posted.
- `429`: you hit the hourly limit; wait for `Retry-After` and batch your asks into one message.
- `409 slack_not_connected`: Slack is not connected for this company; say so on the issue instead of retrying.
