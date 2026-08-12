---
name: hostinger-dns
description: >
  Manage DNS records on Hostinger domains using the hapi CLI. Point domains to
  S3-hosted websites, set up email records, or configure subdomains. Use when
  connecting a deployed landing page to a custom domain.
compatibility: Requires hapi CLI (Hostinger API CLI) and Python 3.10+
metadata:
  author: agents-studio
  version: "1.0"
  clawdbot:
    emoji: 🌐
    requires:
      env:
        - HAPI_API_TOKEN (passed per-tenant, not stored globally)
---

# Hostinger DNS Management

Manage DNS records on Hostinger domains via the `hapi` CLI. Used to point a domain to an S3 static website or configure other DNS records.

## When to Use

- After deploying a website to S3, connect it to a custom domain
- Set CNAME, A, or other DNS records for a tenant's domain on Hostinger
- Each tenant has their own Hostinger account with their own API token

## Prerequisites

### One-time setup on agents-studio EC2

If `hapi` CLI is not installed:

```bash
# Install Go (if not present)
apt update && apt install -y golang-go

# Build and install hapi CLI
git clone --depth 1 https://github.com/hostinger/api-cli /tmp/api-cli
cd /tmp/api-cli
go build -o /usr/local/bin/hapi ./cmd/hapi
chmod +x /usr/local/bin/hapi
rm -rf /tmp/api-cli

# Verify
hapi --help
```

Or download a pre-built binary from:
https://github.com/hostinger/api-cli/releases

## Credential Architecture

Each tenant stores their Hostinger API token in Paperclip's connector system. The agent fetches credentials per-tenant from the Paperclip credentials API — no config files written to disk, multi-tenant isolation is automatic.

### Step 1 — Fetch Credentials from Paperclip

```bash
curl -s -X GET "https://agentstudio.matilabs.com/api/agents/$PAPERCLIP_AGENT_ID/connector-credentials/hostinger" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json"
# PAPERCLIP_AGENT_ID and PAPERCLIP_API_KEY are both injected into the agent
# runtime env by Paperclip (see heartbeat.ts adapterConfig.env injection).
```

Expected response:
```json
{
  "type": "hostinger",
  "credentials": {
    "api_token": "1234567890abcdef..."
  }
}
```

Extract `api_token` from the response. Store as shell variable:
```bash
HOSTINGER_API_TOKEN="<api_token>"
```

> **Auth:** `PAPERCLIP_API_KEY` is injected by Paperclip runtime automatically.
> **Tenant isolation:** The credentials endpoint returns credentials scoped to the logged-in user/company — each tenant only sees their own token.

## Workflow

### Step 1 — Fetch Hostinger API Token from Paperclip

```bash
RESPONSE=$(curl -s -X GET "https://agentstudio.matilabs.com/api/agents/$PAPERCLIP_AGENT_ID/connector-credentials/hostinger" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json")

# Extract api_token from JSON response
HOSTINGER_API_TOKEN=$(echo $RESPONSE | grep -o '"api_token":"[^"]*"' | cut -d'"' -f4)
```

If the API returns 404, the Hostinger connector is not configured. Ask the tenant to configure it in Paperclip first.

### Step 2 — List existing DNS records

Before adding records, check what's already configured:

```bash
hapi dns records list $DOMAIN --format json
```

### Step 3 — Point domain to S3

For S3 static websites, use a **CNAME record** pointing to the S3 website URL:

```bash
hapi dns records create $DOMAIN \
  --name www \
  --type CNAME \
  --content $S3_WEBSITE_URL \
  --ttl 3600
```

For apex domains, use a CloudFront or Route53 alias instead — S3 doesn't serve from an apex A record. For a simple CNAME setup, use the `www` subdomain.

### Step 4 — Verify

```bash
hapi dns records list $DOMAIN --format json
```

---

**Required task inputs:**
| Variable | Description | Example |
|----------|-------------|---------|
| `$DOMAIN` | Domain to configure DNS for | `mydomain.com` |
| `$S3_WEBSITE_URL` | S3 static website URL from deploy-website-s3 | `my-site.s3-website-us-east-1.amazonaws.com` |


## hapi CLI Reference

```
hapi <group> <subgroup> <verb> [args] [flags]

# DNS commands
hapi dns records list <domain> [--format json|table|tree]
hapi dns records create <domain> [flags]
hapi dns records update <domain> <record_id> [flags]
hapi dns records delete <domain> <record_id>
```

### Common DNS record types

| Type | Use case | Key flag |
|------|----------|---------|
| CNAME | Point subdomain to S3/CloudFront | `--content <target>` |
| A | Point apex domain to IP | `--content <ip>` |
| MX | Email routing | `--content <mailserver>` `--priority <n>` |
| TXT | Domain verification | `--content "<text>"` |
| NS | Name servers (read-only) | - |

### Record creation flags (DNS)

```
--name string       Record name (e.g. "www", "@" for apex, "shop")
--type string       Record type: A, AAAA, CNAME, MX, TXT, NS
--content string    Record value (target hostname, IP, etc.)
--ttl int           Time to live in seconds (default: 3600)
--priority int      Priority for MX records
```

### Output formats

```bash
--format json        # Best for scripting and parsing
--format table       # Human-readable
--format tree       # Hierarchical view
```

## Python Script for DNS Management

```python
#!/usr/bin/env python3
"""
hostinger-dns.py
Manage Hostinger DNS records to point a domain to an S3-hosted website.
"""

import json
import os
import subprocess
import sys

def run_hapi(args, api_token):
    """Run hapi CLI with the tenant's API token as env var."""
    env = os.environ.copy()
    env['HAPI_API_TOKEN'] = api_token
    env['HAPI_FORMAT'] = 'json'

    result = subprocess.run(
        ['hapi'] + args,
        env=env,
        capture_output=True,
        text=True
    )
    if result.returncode != 0:
        print(f"❌ hapi failed: {result.stderr}")
        return None
    try:
        return json.loads(result.stdout) if result.stdout.strip() else {}
    except json.JSONDecodeError:
        return {'raw': result.stdout}

def list_records(domain, api_token):
    """List all DNS records for a domain."""
    print(f"📋 Fetching DNS records for: {domain}")
    return run_hapi(['dns', 'records', 'list', domain], api_token)

def find_record_by_name(records, name, record_type=None):
    """Find a specific record by name and optionally type."""
    if not records:
        return None
    # records is a list or dict depending on hapi output format
    items = records if isinstance(records, list) else records.get('records', [])
    for rec in items:
        if rec.get('name') == name or rec.get('name') == f"{name}.":
            if record_type is None or rec.get('type') == record_type:
                return rec
    return None

def create_cname_record(domain, subdomain, target, ttl=3600, api_token=None):
    """Create a CNAME record pointing to the target hostname."""
    print(f"🔗 Creating CNAME: {subdomain}.{domain} → {target}")
    args = [
        'dns', 'records', 'create', domain,
        '--name', subdomain,
        '--type', 'CNAME',
        '--content', target,
        '--ttl', str(ttl)
    ]
    return run_hapi(args, api_token)

def create_a_record(domain, name, ip, ttl=3600, api_token=None):
    """Create an A record."""
    print(f"🌐 Creating A record: {name}.{domain} → {ip}")
    args = [
        'dns', 'records', 'create', domain,
        '--name', name,
        '--type', 'A',
        '--content', ip,
        '--ttl', str(ttl)
    ]
    return run_hapi(args, api_token)

def delete_record(domain, record_id, api_token):
    """Delete a DNS record by ID."""
    print(f"🗑️  Deleting record ID: {record_id}")
    return run_hapi(['dns', 'records', 'delete', domain, record_id], api_token)

def update_record(domain, record_id, new_content, api_token):
    """Update a record's content."""
    print(f"✏️  Updating record {record_id} → {new_content}")
    return run_hapi(
        ['dns', 'records', 'update', domain, record_id, '--content', new_content],
        api_token
    )

def point_domain_to_s3(domain, subdomain, s3_website_url, api_token, ttl=3600):
    """
    Main function: point a subdomain to an S3 static website URL.
    Handles existing record cleanup and creation.
    """
    # Step 1: List existing records
    records = list_records(domain, api_token)
    existing = find_record_by_name(records, subdomain)

    if existing:
        rec_id = existing.get('id')
        existing_content = existing.get('content', '')
        print(f"ℹ️  Found existing {subdomain} record: {existing_content} (ID: {rec_id})")

        if existing_content.rstrip('.') == s3_website_url.rstrip('.'):
            print("✅ Record already points to the correct target. No changes needed.")
            return {'status': 'no_change', 'url': s3_website_url, 'record': existing}
        else:
            # Update existing record
            result = update_record(domain, rec_id, s3_website_url, api_token)
            print(f"✅ Record updated to: {s3_website_url}")
            return {'status': 'updated', 'url': s3_website_url, 'record': result}
    else:
        # Create new record
        result = create_cname_record(domain, subdomain, s3_website_url, ttl, api_token)
        print(f"✅ CNAME record created: {subdomain}.{domain} → {s3_website_url}")
        return {'status': 'created', 'url': s3_website_url, 'result': result}

def main():
    # Fetch credentials from Paperclip credentials endpoint
    api_key = os.environ.get('PAPERCLIP_API_KEY')
    if not api_key:
        print("❌ PAPERCLIP_API_KEY not set. Are you running inside Paperclip?")
        sys.exit(1)

    import urllib.request
    req = urllib.request.Request(
        f'https://agentstudio.matilabs.com/api/agents/{os.environ["PAPERCLIP_AGENT_ID"]}/connector-credentials/hostinger',
        headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            creds = json.loads(resp.read())
    except Exception as e:
        print(f"❌ Failed to fetch Hostinger credentials from Paperclip: {e}")
        print("   Make sure the Hostinger connector is configured in Paperclip.")
        sys.exit(1)

    api_token = creds.get('credentials', {}).get('api_token')
    if not api_token:
        print("❌ No api_token found in credentials response")
        sys.exit(1)

    # Domain: prefer DOMAIN env var, else try to get from connector config
    domain = os.environ.get('DOMAIN')
    if not domain:
        domain = creds.get('config', {}).get('domain')
    if not domain:
        print("❌ DOMAIN env var not set and no domain found in connector config.")
        print("   Configure the domain in Paperclip → Connectors → Hostinger, or pass DOMAIN=mydomain.com")
        sys.exit(1)
    domain = domain.strip()

    # Get S3 URL from args or environment
    s3_url = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('S3_WEBSITE_URL')
    subdomain = sys.argv[2] if len(sys.argv) > 2 else 'www'

    if not s3_url:
        print("❌ S3 website URL not provided. Pass as argument or set S3_WEBSITE_URL env var.")
        sys.exit(1)

    print(f"🌐 Connecting domain to S3 website")
    print(f"   Domain: {domain}")
    print(f"   Subdomain: {subdomain}")
    print(f"   Target: {s3_url}")

    result = point_domain_to_s3(domain, subdomain, s3_url, api_token)

    print(f"\n✅ DNS setup complete!")
    print(f"   Domain: {domain}")
    print(f"   Points to: {result['url']}")
    print(f"   Status: {result['status']}")
    print(f"\n⏳ DNS propagation takes 5 min to 48 hours")
    print(f"\n---RESULT---")
    print(f"DOMAIN={domain}")
    print(f"SUBDOMAIN={subdomain}")
    print(f"S3_URL={result['url']}")
    print(f"STATUS={result['status']}")
    print(f"---END---")

if __name__ == '__main__':
    main()
```

## Usage

```bash
# Point www.mydomain.com to the S3 website
# (PAPERCLIP_API_KEY is injected automatically by Paperclip runtime)
DOMAIN=mydomain.com S3_WEBSITE_URL=http://my-landing-page.s3-website-us-east-1.amazonaws.com \
  python3 hostinger-dns.py
```

Claude Code runs this skill by:
1. Running deploy-website-s3 first to get the S3_WEBSITE_URL
2. Passing DOMAIN and S3_WEBSITE_URL as environment variables
3. The Python script fetches HOSTINGER_API_TOKEN from Paperclip credentials endpoint

Claude Code should:
1. Run deploy-website-s3 first to get `HOSTED_URL`
2. Read tenant's `.tenant_hostinger.json` for domain + API token
3. Run hostinger-dns with the S3 URL
4. Return the DNS connection status

## Combined End-to-End Flow

```
1. Tenant: "Build and deploy my landing page"

2. Agent builds site → saves to workspace

3. Agent deploys to S3:
   python3 deploy-website-s3.py
   → Returns: S3_WEBSITE_URL=http://my-site.s3-website-us-east-1.amazonaws.com

4. Agent connects domain:
   DOMAIN=mydomain.com S3_WEBSITE_URL=http://my-site.s3-website-us-east-1.amazonaws.com \
     python3 hostinger-dns.py
   → Creates/updates CNAME record pointing to S3 URL

5. Agent reports to tenant:
   "🌐 Your landing page is live!
    - Website: http://my-site.s3-website-us-east-1.amazonaws.com
    - Domain: www.mydomain.com (DNS propagating, ~5 min to 48 hrs)"
```

## Error Handling

| Error | Cause | Resolution |
|-------|-------|-----------|
| hapi: command not found | CLI not installed | Install hapi on EC2 first |
| Authentication failed | Invalid/expired API token | Tenant must generate new token from hPanel |
| Domain not found | Domain not in Hostinger account | Verify domain is hosted on Hostinger |
| Record limit reached | Too many records | Delete unused records |
| CNAME conflict | Apex domain already has A record | Use www subdomain, or use CloudFront for apex |

## Getting Hostinger API Token

Guide tenant to:
1. Log in to hPanel: https://hpanel.hostinger.com
2. Go to Account → API
3. Generate new API token
4. Go to Paperclip → Connectors → Hostinger → Configure
5. Paste their Hostinger API token and save

The token is encrypted at rest and fetched via the credentials API at runtime — no files stored locally.

## Security Notes

- API token fetched from Paperclip credentials endpoint at runtime — never written to disk
- Credentials scoped per (companyId, userId) — tenant isolation enforced by Paperclip
- DNS changes propagate globally — warn tenant about propagation time (5 min to 48 hrs)
- hapi CLI must be installed on the EC2 before use
