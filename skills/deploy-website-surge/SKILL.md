---
name: deploy-website-surge
description: >
  Deploy a static website to Surge.sh — direct CLI deploy, no GitHub needed.
  Fetches a Surge auth token from the Paperclip API (per-tenant connector),
  then runs `npx surge` to upload the local build to Surge CDN. Use when
  a tenant needs to deploy a landing page, marketing site, or static build
  and the AWS/S3 path is too painful (IAM credentials, CloudFront, bucket
  policy JSON, etc.). Replaces deploy-website-s3 with zero GitHub coupling.
compatibility: >
  Claude Code running on agentstudio EC2. Surge connector must be configured
  in Paperclip for the tenant (token stored in DB). Node + npx must be
  available on the EC2 host. Works for plain static sites AND React/Next.js
  static exports.
---

# Deploy Website to Surge.sh

Direct CLI deploy of a static website to Surge.sh. Fetches the per-tenant
Surge auth token from the Paperclip API, then runs `npx surge` to push the
local build to Surge's CDN. **No GitHub, no S3, no IAM roles.**

## How It Works

1. Call Paperclip API → get Surge auth token (per-tenant, stored in connector DB)
2. Run `npx surge ./<build_dir> <subdomain>.surge.sh --token ***` → upload to Surge CDN
3. Return the public URL

## Prerequisites

- `surge` connector configured in Paperclip for the tenant (token stored in DB)
- Node + `npx` available on EC2
- Website files provided as input (local path or workspace artifact)
- Output directory must contain an `index.html` at the root

## Step-by-Step Instructions

Claude Code executes these commands in order. Each step is a shell command
executed via exec(). Replace `<...>` placeholders with actual values.

---

### Step 1 — Get Surge Auth Token from Paperclip

```bash
curl -s -X GET "https://agentstudio.matilabs.com/api/agents/$PAPERCLIP_AGENT_ID/connector-credentials/surge" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json"
# PAPERCLIP_AGENT_ID and PAPERCLIP_API_KEY are both injected into the agent
# runtime env by Paperclip (see heartbeat.ts adapterConfig.env injection).
```

Expected response:
```json
{
  "type": "surge",
  "credentials": {
    "token": "******",
    "default_domain": "my-tenant-site"
  }
}
```

Extract `token` and `default_domain` (or `subdomain`) from the response.
Store them as shell variables.

If the connector is missing → `404`. Configure the Surge connector in
Paperclip UI before retrying.

---

### Step 2 — Deploy with Surge

```bash
SURGE_TOKEN="<token>"
DOMAIN="<subdomain>.surge.sh"
BUILD_DIR="<website_source_path>"

# First-time: npx surge will install the CLI on demand. No prior install needed.
npx --yes surge "$BUILD_DIR" "$DOMAIN" --token "$SURGE_TOKEN"
```

Example:
```bash
npx --yes surge ./dist my-landing-page.surge.sh --token "eyJhbGciOi..."
```

Expected output (last lines):
```
Success! Published to my-landing-page.surge.sh
```

If errors appear:
- `EACCES: permission denied` → BUILD_DIR is not readable by the agent runtime
- `Login is required` → token expired/invalid. Re-fetch from Paperclip API.
- `ENOTFOUND` or network errors → EC2 egress blocked. Check security group.

---

### Step 3 — Verify Deployment

```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://<subdomain>.surge.sh"
```

Expected: `200`

---

## Input Variables

| Variable | Value | Source |
|----------|-------|--------|
| `PAPERCLIP_API_KEY` | Paperclip auth token | Injected by Paperclip runtime |
| `PAPERCLIP_AGENT_ID` | Paperclip agent ID | Injected by Paperclip runtime |
| `<website_source_path>` | Path to static site files | Passed as task input |
| `<subdomain>` | Desired subdomain | From Step 1 `default_domain` or task input |

## Output

Report to the parent agent:

```
✅ Website deployed to Surge!

Domain: https://<subdomain>.surge.sh
Build dir: <website_source_path>

Files synced: <count from surge output>

Next step: Use hostinger-dns skill to point a custom domain to this URL
```

## Error Handling

| Error | Meaning | Fix |
|-------|---------|-----|
| `curl: (22) 404` on credentials fetch | Surge connector not configured | Add Surge connector in Paperclip UI, paste token |
| `Login is required` from surge | Token expired/revoked | Re-issue Surge token at surge.sh, update Paperclip connector |
| `EACCES: permission denied` | BUILD_DIR not readable | chmod -R a+rX the build directory |
| `ENOTFOUND` / network timeout | EC2 egress issue | Check EC2 security group outbound rules, allow 443 |
| Surge prints `Invalid CNAME` | Domain already taken (different account) | Pick a different subdomain |

## Connecting a Custom Domain

Surge supports custom domains via CNAME. The agent should:

1. Use the existing `hostinger-dns` skill to create a CNAME record:
   - Host: `www` (or `@`)
   - Value: `surge.sh` (apex) or `<subdomain>.surge.sh` (subdomain)
2. Wait 1–5 minutes for DNS propagation
3. From inside the EC2, run:
   ```bash
   echo "<subdomain>.surge.sh" | npx --yes surge --domain "<custom-domain>" --token "$SURGE_TOKEN"
   ```

## Why Surge vs. S3

- **One command** vs six (s3 sync + website hosting + public policy)
- **No AWS credentials** at all (token is just a JWT, not access key + secret)
- **No IAM roles**, no `s3:PutObject` permission debugging
- **No CloudFront** setup, no OAI/OAC, no bucket policies
- **Custom domains via CNAME** in one line
- **Free tier**: 100 deploys/month, unlimited static assets
- **Trades off**: less enterprise control, smaller CDN scale than CloudFront. Acceptable for landing pages and marketing sites.

## What to Do If `npx surge` Fails on EC2

```bash
# Install surge globally first
npm install -g surge

# Then deploy
surge ./dist <subdomain>.surge.sh --token "$SURGE_TOKEN"
```

Verify:
```bash
surge --version
```

Then retry the deployment steps.