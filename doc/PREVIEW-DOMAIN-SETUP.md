# Preview domain setup

How to give an Agent Studio instance a wildcard preview domain
(`*.<preview domain>`) with a trusted TLS certificate that renews itself, and
turn previews on per company. Written for our cloud install and for on-prem
client installs.

Reference install: `agentstudio.matilabs.com`, preview domain
`preview.matilabs.com` (AWS EC2, Ubuntu, nginx, certbot, pm2).

## Who does what

| Who | Where | What |
|---|---|---|
| Server operator (once per install) | Host shell + DNS provider | Wildcard A record, hook secret, certbot, nginx block (sections 2–5 below) |
| Instance admin | **Instance Settings → Previews** | Preview domain, DNS zone, Hostinger API token, Test DNS, per-company toggles |
| Agents | API | Expose a preview; get a clear error if previews are off for their company |

Nothing about previews lives in company connectors or agent prompts. The DNS
token belongs to the instance, so no single company can break previews for
the others.

## How certificate renewal works

```
certbot (root, certbot.timer, ~every 60 days)
  └─ --manual-auth-hook / --manual-cleanup-hook
       scripts/preview-dns-certbot-hook.sh present|cleanup
         └─ POST http://127.0.0.1:3100/api/internal/preview-dns/{present|cleanup}
              (direct loopback only + X-Preview-DNS-Secret)
              └─ Agent Studio reads domain, zone and the encrypted Hostinger token
                 from Instance Settings → Previews and writes/removes the
                 _acme-challenge.<preview domain> TXT record via the Hostinger API
```

- One wildcard certificate covers every preview, so Let's Encrypt rate limits
  never apply per preview.
- `present` returns only after the zone's authoritative nameservers serve the
  record, so validation never races DNS.
- The endpoint returns 404 until `PAPERCLIP_PREVIEW_DNS_HOOK_SECRET` is set,
  403 for requests that came through nginx (`X-Real-IP`/`X-Forwarded-For`
  present) or carry the wrong secret, and only accepts the configured
  preview domain.
- Every challenge result (success or the exact error) shows under
  **Previews → Status → Last certificate challenge**.

Code: `server/src/routes/preview-dns.ts`, `server/src/routes/instance-previews.ts`,
`server/src/services/instance-previews.ts`, `server/src/services/hostinger-dns.ts`,
`scripts/preview-dns-certbot-hook.sh`, UI `ui/src/pages/InstancePreviewsSettings.tsx`.

## 1. Prerequisites

| What | Check |
|---|---|
| Domain DNS hosted on Hostinger | `dig +short NS <zone>` → `ns1/ns2.dns-parking.com` |
| No CAA record blocking Let's Encrypt | `dig +short CAA <zone>` empty, or includes `letsencrypt.org` |
| Static public IP | AWS: Elastic IP. Otherwise the A record breaks on stop/start |
| nginx + certbot installed, renewal timer active | `systemctl list-timers \| grep certbot` |
| nginx `proxy_read_timeout` ≥ 150s on the Agent Studio location | The **Test DNS** button can take up to 120 s |
| Hostinger API token that can edit the zone | hPanel → Profile → API. Pick the longest expiry; note the date |

## 2. DNS record (Hostinger hPanel)

| Type | Name | Points to | TTL |
|---|---|---|---|
| A | `*.preview` | `<server ip>` | lowest |

```sh
dig +short A test.<preview domain> @ns1.dns-parking.com   # → <server ip>
```

## 3. Hook secret (host)

Add to the `paperclip` app `env` in `ecosystem.config.cjs` (back it up first):

```js
PAPERCLIP_PREVIEW_DNS_HOOK_SECRET: "<openssl rand -hex 32>",
```

Write the same value to a root-only file for certbot:

```sh
sudo install -d -m 700 /etc/paperclip
printf '%s\n' "<secret>" | sudo install -m 600 /dev/stdin /etc/paperclip/preview-dns-hook.secret
pm2 reload ecosystem.config.cjs --only paperclip --update-env
```

Check (expect `403`, i.e. live and guarded):

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3100/api/internal/preview-dns/present
```

## 4. Instance Settings → Previews (UI)

1. **Preview domain** `preview.matilabs.com`, **DNS zone** `matilabs.com` → Save domain.
2. **Hostinger API token** → Save token (stored encrypted; never shown again).
3. **Test** → must say "Works — … was published and removed". A failure shows
   Hostinger's exact error (e.g. `HTTP 401 Unauthenticated` = bad/expired token).
4. Turn on **Companies** that should be able to share previews.

## 5. Issue the wildcard certificate (host)

_TBD — filled in from the reference install._

## 6. nginx server block (host)

_TBD — filled in from the reference install._

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Hook gets `404` | `PAPERCLIP_PREVIEW_DNS_HOOK_SECRET` missing from the running process. Check `ecosystem.config.cjs`, then `pm2 reload … --update-env`. |
| Hook gets `403` | Secret file ≠ env value, the call went through nginx, or the domain isn't the configured preview domain. The hook must call `127.0.0.1:3100` directly. |
| Hook gets `422 Previews DNS is not configured` | Domain, zone or token not saved in Instance Settings → Previews. |
| `HTTP 401 Unauthenticated` (Test DNS or Last certificate challenge) | Hostinger token expired or revoked. Create a new one in hPanel → Profile → API and save it on the Previews page. Seen on the reference install on 2026-10-18 with an old connector token. |
| `did not appear on authoritative nameservers` | Hostinger accepted the write but didn't publish in time. Retry; check the zone in hPanel. |
| Certificate shows "Not issued yet" | nginx isn't serving a `*.<preview domain>` certificate yet — finish sections 5–6. |
| Test DNS button times out in the browser | nginx `proxy_read_timeout` below ~150 s. |

Server logs: `pm2 logs paperclip`, search `preview-dns`.
