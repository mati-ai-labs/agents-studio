# Two-way Slack setup

Set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET` in the server environment. Set `PAPERCLIP_PUBLIC_URL` to the externally reachable HTTPS origin.

In the Slack app configuration use:

- OAuth redirect: `https://<paperclip-host>/api/connectors/slack/callback`
- Event Request URL: `https://<paperclip-host>/api/connectors/slack/events`
- Bot events: `app_mention` and `message.channels`

Reinstall the app after changing scopes, then invite `@Agent Studio` to each public channel before creating a channel route. A root mention creates one Paperclip issue; replies in that thread become issue comments. Slack delivery is at-least-once, while issue/comment creation is deduplicated transactionally.
