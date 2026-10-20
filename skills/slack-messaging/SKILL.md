---
name: slack-messaging
description: Post a message in the company's Slack and tag the people responsible for an item. Use when work needs a human's decision, review, access or action and the issue comment alone won't reach them, or when the user asks you to notify someone on Slack.
---

# Slack messaging

You can post in the company's Slack workspace through the Paperclip API. The server holds the Slack bot token; you never see it, and you never need it.

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

Use a channel with `canPost: true`. Prefer the channel the issue came from (if the issue came from Slack, reply in that thread with `threadTs`), then the owners list's channel, then the team's main channel. Never DM, and never post to a channel unrelated to the work.

## Post

```bash
curl -sS -f -X POST "$API/api/companies/$PAPERCLIP_COMPANY_ID/slack/messages" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d '{"channel":"#eng","mentionUserIds":["U0123ABCD"],"issueId":"'"$PAPERCLIP_TASK_ID"'","text":"Need your call: should coach notes be visible to admins? Blocking the notes API (LCH-31)."}'
```

- `channel`: channel id, `#name` or `name`.
- `mentionUserIds`: Slack user ids from the members list (max 10). The server turns them into real @mentions.
- `issueId`: always pass it when the message is about an issue. The server adds your name and the issue link, and records the message on the issue.
- `threadTs` (optional): reply inside an existing thread.

Write the message so the person can act without opening anything: what you need, from whom, by when if it matters, and the one-line reason. Two or three sentences. No secrets, tokens, passwords or customer personal data.

After posting, add an issue comment naming who you tagged and why, so the issue shows it.

## Errors

- `422 not_in_channel`: the bot is not in that private channel; pick another or ask a human to invite it.
- `422 unknown_mention`: an id is not in the members list; re-read the list.
- `429`: you hit the hourly limit; wait for `Retry-After` and batch your asks into one message.
- `409 slack_not_connected`: Slack is not connected for this company; say so on the issue instead of retrying.
