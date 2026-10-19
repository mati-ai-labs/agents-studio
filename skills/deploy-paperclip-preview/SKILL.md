---
name: deploy-paperclip-preview
description: >
  Deploy and expose a dynamic frontend or backend application through
  Paperclip's authenticated localhost preview route. Use when an agent needs
  to run a workspace service and return a temporary preview URL.
  Do not use this for static CDN deployments that belong on Surge or S3.
metadata:
  role: dynamic_preview_deployment
  version: "1.0.0"
  compatibility: Paperclip workspace runtime services with an injected PORT
---

# Deploy a Paperclip Preview

Use Paperclip's runtime service manager to run the application locally and
expose it through Paperclip. Never replace this workflow with Surge, ngrok,
Cloudflare Tunnel, a public port, or a second process supervisor.

## When to use

Use this skill when the deliverable is a dynamic website, frontend with an
API, dashboard, app, or other service that must remain running on the
Agent Studio host while a reviewer accesses it through Paperclip.

For a static build containing only files such as `index.html`, use the
appropriate static deployment skill instead.

## Required workflow

### 1. Inspect the application

- Read the package scripts and identify the correct development or production
  start command.
- Make the server listen on the `PORT` environment variable injected by
  Paperclip. Do not hard-code a port.
- Bind to localhost or `0.0.0.0` as required by the framework; the service
  must be reachable from `http://127.0.0.1:${port}` on the host.
- No base path or app changes are needed: the app is served at the root of
  its own preview subdomain, exactly as it runs on `http://127.0.0.1:${port}/`.

- For larger single-page apps, prefer serving a production build (build, then
  a static preview server such as `vite preview`) over the dev server. A dev
  server sends hundreds of separate module requests; on a slow or flaky
  connection one of them fails and the page stays blank. Restart the service
  to rebuild after code changes. Use the dev server only when reviewers need
  hot reload.

If the project has separate frontend and backend processes, expose one web
service as the preview entrypoint and route its API/WebSocket requests to the
workspace backend through relative paths. Do not publish the backend
separately unless the user explicitly requests that architecture.

If the backend checks CORS, add `https://*.<preview-domain>` to its allowed
origins in workspace-local config (never committed). A proxy in front of the
backend forwards the browser's `Origin` header, so without it every API call
fails, often as a `500` rather than a visible CORS error.

### 2. Configure the Paperclip runtime service

Add or update the project workspace runtime configuration with a service like
this, adapting only the command and readiness path to the project:

```json
{
  "commands": [
    {
      "id": "web",
      "name": "web",
      "kind": "service",
      "command": "pnpm dev",
      "cwd": ".",
      "port": { "type": "auto", "envKey": "PORT" },
      "readiness": {
        "type": "http",
        "urlTemplate": "http://127.0.0.1:${port}"
      },
      "expose": {
        "type": "paperclip_preview"
      },
      "lifecycle": "shared",
      "reuseScope": "project_workspace"
    }
  ]
}
```

The `expose.type` value must be exactly `paperclip_preview`. Keep
`lifecycle: "shared"` and `reuseScope: "project_workspace"` unless the
board operator has specified a different lifecycle.

**Agents cannot write runtime commands directly** (the API rejects agent keys
for host-executed commands). If the project workspace has no suitable service,
submit the config for board approval and stop until it is approved:

```bash
curl -fsS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/approvals" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  --data '{"type":"workspace_runtime_config","issueIds":["<issue-id>"],
    "payload":{"projectId":"<project-id>","workspaceId":"<project-workspace-id>",
      "workspaceRuntime":{"services":[ ...service objects as above... ]}}}'
```

Post one comment saying the preview service is awaiting board approval, set
the issue to `blocked` on that approval, and exit. Do not search the host for
workarounds. You are woken when it is approved; then continue below.

Start the service through Paperclip's workspace runtime controls:
`POST /api/projects/<project-id>/workspaces/<workspace-id>/runtime-services/start`. Do not
start it only with `nohup`, `screen`, `tmux`, or a manually detached shell;
Paperclip must own the runtime-service record and port.

### 3. Wait for readiness and use the generated URL

Wait for the HTTP readiness check to pass, then use the preview URL returned
by Paperclip (the runtime service's `url`, or `url` from the lease API below):

```text
https://<company-code>-<service>-<random>.<preview-domain>/
```

The link is stable: it stays the same across restarts of the same service, so
post it once and keep using it. Reviewers sign in with their Agent Studio
account the first time they open it. Never invent the slug or substitute the
localhost URL for the reviewer-facing link. The app's own cookies and
`Authorization` headers pass through untouched.

If the service was already started without `paperclip_preview`, create a lease
only through the authenticated Paperclip API when the required identifiers are
available:

```bash
curl -fsS -X POST \
  "${PAPERCLIP_API_URL:-https://agentstudio.matilabs.com}/api/companies/${PAPERCLIP_COMPANY_ID}/previews" \
  -H "Authorization: Bearer ${PAPERCLIP_API_KEY}" \
  -H "Content-Type: application/json" \
  --data '{"runtimeServiceId":"<running-service-id>"}'
```

Do not bypass company authorization or guess a runtime service ID. If those
identifiers are unavailable, ask the board operator to start the configured
runtime service.

### 4. Verify before reporting success

Verify all of the following that apply:

- the runtime service is `running` and its readiness check passes;
- the app responds through Paperclip. You can't sign in to the reviewer link,
  so check the lease's `pathUrl` with your key instead:
  `curl -fsS -H "Authorization: Bearer $PAPERCLIP_API_KEY" "<pathUrl>/"`;
- frontend API calls reach the intended workspace backend. Test one real API
  route (for example a login with a dummy account) through the web service's
  port with the header `Origin: https://<slug>.<preview-domain>`; expect the
  app's normal error (such as `401`), not a `500`. A page that renders is not
  proof that the app works;
- every service in the workspace is still running. Restarting one service or
  saving the runtime config can stop another, so check each one;
- WebSocket or hot-reload behavior works when the application requires it;
- the returned link is the actual Paperclip URL, not a localhost or tunnel URL.

Report the preview URL, runtime service ID, command, selected port, and checks
performed. Do not claim deployment success without a working
preview URL or an explicit, evidenced blocker.

## Lease and lifecycle rules

- One stable link per service. It lapses only after 30 days without a visit
  (`410`); restarting the service through Paperclip brings the same link back.
- Revoking a lease (`DELETE /api/previews/<id>`) retires its link for good.
- Explicitly stopping or closing the workspace stops the local service.
- Reuse an active project-workspace service instead of starting duplicates.

## Troubleshooting

- **`403` with `"code": "previews_disabled"`:** previews are switched off for
  this company. Do not retry, change the service, or look for another way to
  publish. Post one comment saying an instance admin must turn previews on in
  **Instance settings → Previews**, set the issue to `blocked`, and exit.
- **No preview URL:** if the service is running but has no URL, call the
  lease API above; it returns the reason (for example `previews_disabled`).
  Otherwise confirm the service uses `expose.type: "paperclip_preview"`,
  is running, and passed readiness. If it was started manually, use the
  authenticated lease API fallback.
- **`EADDRINUSE`:** remove the hard-coded port and let Paperclip allocate one;
  then stop or reuse the existing Paperclip-managed service.
- **Blank page or missing assets:** check the app works at
  `http://127.0.0.1:${port}/` on the host first; the preview serves the same paths.
  If it works locally but is blank for reviewers, and it runs on a dev server,
  switch the service to a production build (see step 1).
- **API or WebSocket failures:** keep them on the same exposed web entrypoint,
  use relative paths, and verify the workspace backend is running.
- **API calls return `500` only from the browser:** the backend's CORS check is
  rejecting the preview origin. Repeat the call with the `Origin` header to
  confirm, then allow `https://*.<preview-domain>` (see step 1).
- **`410 Gone`:** the link lapsed after 30 idle days. Restart the service
  through Paperclip (or call the lease API); the link comes back unchanged.
- **`503` "app is not running":** the service stopped. Start it again through
  Paperclip; the link stays the same.
