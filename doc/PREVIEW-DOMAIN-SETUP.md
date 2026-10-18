# Preview domain setup

How to give an Agent Studio instance a wildcard preview domain
(`*.<preview domain>`) with a trusted TLS certificate that renews itself, and
turn previews on per company. Written for our cloud install and for on-prem
client installs.

Reference install: `agentstudio.matilabs.com`, preview domain
`agent-preview.site` (AWS EC2, Ubuntu, nginx, certbot, pm2). Set up
2026-10-18; wildcard cert valid until 2027-01-16 and auto-renewing.

**Recommendation:** use a dedicated domain for previews (we bought
`agent-preview.site` on Hostinger in the same account as the API token).
Preview apps run code agents wrote; on a separate registrable domain they
can't read or set cookies for the Agent Studio domain. A new domain took
~13 minutes to resolve publicly.

## Who does what

| Who | Where | What |
|---|---|---|
| Server operator (once per install) | Host shell + DNS provider | Wildcard A record, hook secret, certbot, nginx block (sections 2–5 below) |
| Instance admin | **Instance Settings → Previews** | Preview domain, DNS zone, Hostinger API token, Test DNS, per-company toggles |
| Agents | API | Start the app service; get back a stable `https://<company>-<service>-<random>.<preview domain>/` link, or a clear `previews_disabled` error |
| Reviewers | Browser | Open the link and sign in with their Agent Studio account (once per preview, 8 hours) |

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
| Hostinger API token for a zone you control | `hpanel.hostinger.com/api` → **Generate new token** (longest expiry; note the date). A token only works for domains **owned by the account that created it** — see "Challenge zone" below |

## Challenge zone (direct vs delegated)

Let's Encrypt gives a **new random value on every issue/renewal** (~60 days)
that must be published as a TXT record at `_acme-challenge.<preview domain>`.
Agent Studio writes it automatically through the DNS API, so the token must be
able to edit the zone that record lives in: the *challenge zone*.

- **Direct**: the preview domain is inside the token's zone (preview
  `preview.example.com`, zone `example.com`). TXT records go to
  `_acme-challenge.preview.example.com`. No extra record.
- **Delegated**: the preview domain's DNS belongs to an account the token
  can't edit (another Hostinger account, a client's IT, …). Use any Hostinger
  domain the token's account owns as the zone, and add **one static CNAME,
  once**, where the preview domain is managed:

  ```
  _acme-challenge.<preview domain>  CNAME  _acme-challenge.<preview-domain-with-dashes>.<challenge zone>
  ```

  The Previews page shows the exact record. Let's Encrypt follows the CNAME,
  so the changing TXT value lives in the challenge zone and the preview
  domain's DNS is never written by Agent Studio.

Example: preview `preview.matilabs.com` where matilabs.com is owned by a
different Hostinger account, challenge zone `getkinly.com`, CNAME
`_acme-challenge.preview.matilabs.com → _acme-challenge.preview-matilabs-com.getkinly.com`.
(The reference install ended up direct on its own domain instead.)

Prefer delegated for client installs: the client adds two static records
(wildcard A + CNAME) and never hands over API access to their main domain.

## 2. DNS record (Hostinger hPanel)

| Type | Name | Points to | TTL |
|---|---|---|---|
| A | `*` (dedicated domain) or `*.preview` (subdomain) | `<server ip>` | lowest |
| CNAME (delegated only) | `_acme-challenge.<preview label>` | value shown on the Previews page | lowest |

Both are static and added once by hand in the preview domain's DNS (hPanel
admin access is enough; no API token from that account is needed).

```sh
dig +short A test.<preview domain> @8.8.8.8   # → <server ip> (public resolution, not just Hostinger NS)
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

1. **Preview domain** and **DNS zone the token can edit** → Save domain (reference: both `agent-preview.site`). If delegated, add the CNAME the page shows.
2. **Hostinger API token** → Save token (stored encrypted; never shown again).
3. **Test** → must say "Works — … was published and removed". A failure shows
   Hostinger's exact error (e.g. `HTTP 401 Unauthenticated` = bad/expired token).
4. Turn on **Companies** that should be able to share previews.

## 5. Install the hook and issue the wildcard certificate (host)

Install a standalone copy of the hook so deploys or repo resets can't break
renewals:

```sh
sudo install -m 755 -o root -g root \
  /home/ubuntu/agents-studio/scripts/preview-dns-certbot-hook.sh \
  /usr/local/bin/paperclip-preview-dns-hook
```

Smoke-test it against the real DNS API (expect `{"ok":true,...}` twice, and
the value visible on Hostinger's nameserver in between):

```sh
sudo CERTBOT_DOMAIN=<preview domain> CERTBOT_VALIDATION=hooktest \
  /usr/local/bin/paperclip-preview-dns-hook present
dig +short TXT _acme-challenge.<preview domain> @<hostinger ns>   # "hooktest"
sudo CERTBOT_DOMAIN=<preview domain> /usr/local/bin/paperclip-preview-dns-hook cleanup
```

Hostinger's anycast nameservers can serve a deleted record for ~1 minute;
that's normal.

Issue (an existing certbot account on the host is reused):

```sh
sudo certbot certonly --non-interactive --manual --preferred-challenges dns \
  --manual-auth-hook    "/usr/local/bin/paperclip-preview-dns-hook present" \
  --manual-cleanup-hook "/usr/local/bin/paperclip-preview-dns-hook cleanup" \
  --deploy-hook "systemctl reload nginx" \
  --cert-name <preview domain> -d "*.<preview domain>"
```

Prove unattended renewal, and check the hooks were saved:

```sh
sudo certbot renew --cert-name <preview domain> --dry-run   # "all simulated renewals succeeded"
sudo grep -E "manual_.*hook|renew_hook" /etc/letsencrypt/renewal/<preview domain>.conf
```

`certbot.timer` renews ~30 days before expiry. Every attempt shows on the
Previews page under **Last certificate challenge**.

## 6. nginx server block (host)

Back up first (`sudo tar czf ~/nginx-backup-$(date -u +%Y%m%d%H%M%S).tgz -C /etc nginx`),
then create `/etc/nginx/sites-available/agent-preview` and symlink it into
`sites-enabled`:

```nginx
server {
  listen 443 ssl;
  listen [::]:443 ssl;
  server_name *.<preview domain>;

  ssl_certificate /etc/letsencrypt/live/<preview domain>/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/<preview domain>/privkey.pem;
  include /etc/letsencrypt/options-ssl-nginx.conf;
  ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

  client_max_body_size 50m;

  location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
  }
}

server {
  listen 80;
  listen [::]:80;
  server_name *.<preview domain>;
  return 301 https://$host$request_uri;
}
```

```sh
sudo nginx -t && sudo systemctl reload nginx
```

Verify from outside:

```sh
echo | openssl s_client -connect probe.<preview domain>:443 -servername probe.<preview domain> 2>/dev/null \
  | openssl x509 -noout -subject -enddate          # CN=*.<preview domain>
curl -s -o /dev/null -w '%{http_code} %{ssl_verify_result}\n' https://probe.<preview domain>/   # ssl_verify 0
```

The Previews page **Certificate** card should now say "Valid until …".
An unknown preview host (like `probe.`) answers `404 Preview not found` from
Agent Studio; that confirms nginx → Agent Studio routing works.

The `Upgrade`/`Connection` headers are required: apps' live reload and
WebSockets go through this block.

## 7. How preview links work

- **One stable link per app service:** `<company code>-<service>-<random>`, e.g.
  `https://lch-web-3f9a….agent-preview.site/`. Restarting the service keeps the
  link. A link lapses after 30 days without a visit and comes back unchanged
  when the agent starts the service again. Revoking a lease retires it.
- **Sign-in:** the first visit redirects to Agent Studio
  (`/api/preview-auth/start`). Agent Studio checks the user belongs to the
  company, then sends them back with a 60-second, single-use token. The preview
  host swaps it for an 8-hour cookie (`agentstudio_preview`) valid for that one
  preview only. Users who aren't signed in go through the normal login first.
  Users outside the company see "Preview not found".
- **Switching a company off** in Instance Settings → Previews blocks its links
  immediately (403), including for people already signed in.
- **What reaches the app:** every path and query unchanged, plus the app's own
  cookies and `Authorization` header. Agent Studio's cookies and the
  `agentstudio_preview` cookie are stripped. No HTML/JS rewriting.
- **Old path links** (`<Agent Studio>/preview/<slug>/`) keep working with an
  Agent Studio login or agent API key. Agents use them (`pathUrl` in the lease)
  to check their app, because they can't do the browser sign-in.
- **Server config needed:** `PAPERCLIP_PUBLIC_URL` (the Agent Studio URL users
  sign in at) must be set; previews redirect there to sign in. It is already set
  on standard installs. Cookies are signed with a key derived from the
  instance's secrets master key, so nothing else to configure.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Hook gets `404` | `PAPERCLIP_PREVIEW_DNS_HOOK_SECRET` missing from the running process. Check `ecosystem.config.cjs`, then `pm2 reload … --update-env`. |
| Hook gets `403` | Secret file ≠ env value, the call went through nginx, or the domain isn't the configured preview domain. The hook must call `127.0.0.1:3100` directly. |
| Hook gets `422 Previews DNS is not configured` | Domain, zone or token not saved in Instance Settings → Previews. |
| `HTTP 401 Unauthenticated` (Test DNS or Last certificate challenge) | Hostinger token expired or revoked. Create a new one at `hpanel.hostinger.com/api` and save it on the Previews page. Seen on the reference install on 2026-10-18 with an old connector token. |
| `HTTP 403 … [DNS:4002] Customer does not own <zone> domain` | The token's Hostinger account doesn't own that zone (e.g. it's in another account you only have admin access to). Use a zone owned by the token's account plus the delegated CNAME. Seen on the reference install on 2026-10-18. |
| Test says `DNS writes work, but the CNAME is missing` | Add the CNAME shown on the page in the preview domain's DNS; re-run Test after it propagates. |
| `did not appear on authoritative nameservers` | Hostinger accepted the write but didn't publish in time. Retry; check the zone in hPanel. |
| Certificate shows "Not issued yet" | nginx isn't serving a `*.<preview domain>` certificate yet — finish sections 5–6. |
| Test DNS button times out in the browser | nginx `proxy_read_timeout` below ~150 s. |
| Preview page says "Preview sign-in not configured" | Set `PAPERCLIP_PUBLIC_URL` in `ecosystem.config.cjs`, then `pm2 reload … --update-env`. |
| Preview host returns `403 Hostname … is not allowed` | Agent Studio doesn't know the preview domain yet: save it on the Previews page (applies within 30 s), or the server runs an older build. |
| Sign-in loops back to the login page | The user's Agent Studio session isn't being set; check normal login works at `PAPERCLIP_PUBLIC_URL`. |
| `503` "app is not running" | The runtime service stopped. Start it again from the project workspace; the link doesn't change. |
| Live reload / WebSocket fails | The nginx block is missing the `Upgrade`/`Connection` headers. |

Server logs: `pm2 logs paperclip`, search `preview-dns`.
