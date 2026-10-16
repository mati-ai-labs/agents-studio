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
- Keep browser asset, API, and WebSocket URLs relative whenever possible.
  If the framework supports a base path, honor the forwarded prefix
  `/preview/<slug>`.

If the project has separate frontend and backend processes, expose one web
service as the preview entrypoint and route its API/WebSocket requests to the
workspace backend through relative paths. Do not publish the backend
separately unless the user explicitly requests that architecture.

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

Start the service through Paperclip's workspace runtime controls. Do not
start it only with `nohup`, `screen`, `tmux`, or a manually detached shell;
Paperclip must own the runtime-service record and port.

### 3. Wait for readiness and use the generated URL

Wait for the HTTP readiness check to pass, then use the preview URL returned
by Paperclip, normally:

```text
https://<paperclip-host>/preview/<generated-slug>/
```

Never invent the slug or substitute the localhost URL for the reviewer-facing
link. The preview is company-authenticated; Paperclip does not forward its
credentials to the local application.

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
- the generated `/preview/<slug>/` URL responds successfully;
- HTML references assets with preview-safe relative or forwarded-prefix URLs;
- frontend API calls reach the intended workspace backend;
- WebSocket or hot-reload behavior works when the application requires it;
- the returned link is the actual Paperclip URL, not a localhost or tunnel URL.

Report the preview URL, runtime service ID, command, selected port, checks
performed, and expiry time. Do not claim deployment success without a working
preview URL or an explicit, evidenced blocker.

## Lease and lifecycle rules

- A preview lease lasts 30 minutes.
- An expired lease returns `410 Gone` and does not stop the local process.
- When a lease expires, create a new lease or restart through Paperclip; do
  not keep using the expired URL.
- Explicitly stopping or closing the workspace stops the local service.
- Reuse an active project-workspace service instead of starting duplicates.

## Troubleshooting

- **No preview URL:** confirm the service uses `expose.type: "paperclip_preview"`,
  is running, and passed readiness. If it was started manually, use the
  authenticated lease API fallback.
- **`EADDRINUSE`:** remove the hard-coded port and let Paperclip allocate one;
  then stop or reuse the existing Paperclip-managed service.
- **Blank page or missing assets:** change root-relative asset/API URLs to
  relative URLs or configure the framework to honor `X-Forwarded-Prefix`.
- **API or WebSocket failures:** keep them on the same exposed web entrypoint,
  use relative paths, and verify the workspace backend is running.
- **`410 Gone`:** the lease expired. Generate a new lease; do not alter the
  expired slug.
