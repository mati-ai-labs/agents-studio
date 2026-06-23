---
name: deploy-website-s3
description: >
  Deploy a static website to AWS S3 using AWS CLI. Fetches tenant credentials
  from Paperclip API, then runs aws s3 sync to upload files.
  Use when a tenant needs to deploy a landing page, marketing site, or static
  build to their S3 bucket.
compatibility: >
  Claude Code running on agentstudio EC2. AWS connector must be configured
  in Paperclip for the tenant. AWS CLI must be installed.
---

# Deploy Website to S3

Deploy a static website to AWS S3 using AWS CLI commands. Credentials are fetched
from the Paperclip API, then used to run aws s3 sync.

## How It Works

1. Call Paperclip API → get AWS credentials (access key + secret key)
2. Call AWS STS → get temporary session credentials (12h validity)
3. Run `aws s3 sync` → upload website files
4. Enable static website hosting on the bucket
5. Set bucket to public read

## Prerequisites

- `aws` connector configured in Paperclip for the tenant (credentials stored in DB)
- AWS CLI installed on EC2
- Website files provided as input (local path or workspace artifact)

## Step-by-Step Instructions

Claude Code executes these commands in order. Each step is a shell command
executed via exec(). Replace `<...>` placeholders with actual values.

---

### Step 1 — Get AWS Credentials from Paperclip

```bash
curl -s -X GET "https://agentstudio.matilabs.com/api/connectors/aws/credentials" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json"
```

Expected response:
```json
{
  "type": "aws",
  "credentials": {
    "aws_access_key_id": "AKIA...",
    "aws_secret_access_key": "...",
    "region": "us-east-1",
    "bucket_name": "my-landing-page"
  }
}
```

Extract `aws_access_key_id`, `aws_secret_access_key`, `region`, `bucket_name`
from the response. Store them as shell variables.

---

### Step 2 — Get Temporary Session Credentials via STS

Use the permanent credentials from Step 1 to call AWS STS and get temporary
session credentials. These are valid for 12 hours and are safe to use for
multiple CLI commands.

```bash
# Replace with values from Step 1
export AWS_ACCESS_KEY_ID="<access_key_id>"
export AWS_SECRET_ACCESS_KEY="<secret_access_key>"
export AWS_REGION="<region>"

# Get session token (valid 12 hours)
SESSION=$(aws sts get-session-token \
  --serial-number arn:aws:iam::123456789012:mfa/user \
  --token-code <mfa_code> \
  --duration-seconds 43200 \
  --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' \
  --output text 2>/dev/null)

# If no MFA is required, use GetSessionToken without MFA
SESSION=$(aws sts get-session-token \
  --duration-seconds 43200 \
  --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' \
  --output text)

# Extract session credentials
export AWS_ACCESS_KEY_ID=$(echo $SESSION | cut -d' ' -f1)
export AWS_SECRET_ACCESS_KEY=$(echo $SESSION | cut -d' ' -f2)
export AWS_SESSION_TOKEN=$(echo $SESSION | cut -d' ' -f3)
export AWS_DEFAULT_REGION=$AWS_REGION
```

> **Note:** If the connector has an MFA device configured, include `--serial-number`
> and `--token-code`. If not, use the non-MFA variant.

If credentials have no MFA, you can skip STS and use them directly (they're
already temporary if they're session credentials):

```bash
# Use credentials directly if already temporary
export AWS_ACCESS_KEY_ID="<access_key_id>"
export AWS_SECRET_ACCESS_KEY="<secret_access_key>"
export AWS_DEFAULT_REGION="<region>"
```

---

### Step 3 — Sync Website Files to S3

```bash
aws s3 sync <website_source_path> s3://<bucket_name>/ \
  --delete \
  --exclude ".DS_Store" \
  --exclude "*.map" \
  --exclude "node_modules/*"
```

Example:
```bash
aws s3 sync ./dist/ s3://my-landing-page/ --delete --exclude "*.map"
```

Expected output: `upload: filename.html to s3://my-landing-page/filename.html` for each file

If `upload failed` errors appear:
- `AccessDenied` → credentials lack `s3:PutObject` permission
- `NoSuchBucket` → bucket does not exist, create it first

---

### Step 4 — Enable Static Website Hosting

```bash
aws s3 website s3://<bucket_name>/ --index-document index.html --error-document 404.html
```

Expected output: no error (exit code 0)

---

### Step 5 — Set Bucket to Public Read

Create a public bucket policy JSON file:

```bash
cat > /tmp/public_policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::<bucket_name>/*"
    }
  ]
}
EOF

aws s3api put-bucket-policy \
  --bucket <bucket_name> \
  --policy file:///tmp/public_policy.json
```

Replace `<bucket_name>` in the policy JSON with the actual bucket name.

---

### Step 6 — Verify Deployment

```bash
aws s3 ls s3://<bucket_name>/ --recursive | head -20
```

---

## Input Variables

| Variable | Value | Source |
|----------|-------|--------|
| `PAPERCLIP_API_KEY` | Paperclip auth token | Injected by Paperclip runtime |
| `<website_source_path>` | Path to static site files | Passed as task input |
| `<bucket_name>` | S3 bucket name | From Step 1 API response |
| `<region>` | AWS region | From Step 1 API response |

## Output

Report to the parent agent:

```
✅ Website deployed to S3!

S3 Bucket: <bucket_name>
Region: <region>
Website URL: http://<bucket_name>.s3-website.<region>.amazonaws.com

Files synced: <count>
Static hosting: enabled
Public access: enabled

Next step: Use hostinger-dns skill to point domain to this URL
```

## Error Handling

| Error | Meaning | Fix |
|-------|---------|-----|
| `curl: (22) The requested URL returned error: 404` | AWS connector not configured | Configure AWS connector in Paperclip UI |
| `curl: (22) The requested URL returned error: 409` | Connector status is not "connected" | Reconnect AWS connector in Paperclip |
| `AccessDenied` on s3 sync | Missing `s3:PutObject` permission | Update IAM policy for this AWS account |
| `NoSuchBucket` | Bucket doesn't exist | Create bucket via AWS console first |
| `InvalidAccessKeyId` | Credentials are wrong or expired | Re-fetch credentials from Paperclip API |
| ` ExpiredTokenException` | Session token expired | Re-run Step 2 to get new session credentials |

## What to Do If AWS CLI Is Not Installed

If `aws` command is not found:

```bash
# Install AWS CLI v2
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "/tmp/awscliv2.zip"
unzip -q /tmp/awscliv2.zip -d /tmp
sudo /tmp/aws/install
```

Verify installation:
```bash
aws --version
```

Then retry the deployment steps.
