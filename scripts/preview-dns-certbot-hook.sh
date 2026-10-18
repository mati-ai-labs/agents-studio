#!/usr/bin/env bash
# certbot DNS-01 hook for the preview wildcard certificate.
#
#   certbot certonly --manual --preferred-challenges dns \
#     --manual-auth-hook    "/path/to/preview-dns-certbot-hook.sh present" \
#     --manual-cleanup-hook "/path/to/preview-dns-certbot-hook.sh cleanup" \
#     --deploy-hook "systemctl reload nginx" \
#     -d '*.preview.example.com'
#
# The hook only forwards certbot's challenge to the local Agent Studio server,
# which writes the TXT record with the company's Hostinger connector token.
#
# Env:
#   PREVIEW_DNS_HOOK_SECRET_FILE  file holding PAPERCLIP_PREVIEW_DNS_HOOK_SECRET
#                                 (default /etc/paperclip/preview-dns-hook.secret)
#   PREVIEW_DNS_HOOK_URL          default http://127.0.0.1:3100/api/internal/preview-dns
set -euo pipefail

action="${1:?usage: preview-dns-certbot-hook.sh present|cleanup}"
secret_file="${PREVIEW_DNS_HOOK_SECRET_FILE:-/etc/paperclip/preview-dns-hook.secret}"
base_url="${PREVIEW_DNS_HOOK_URL:-http://127.0.0.1:3100/api/internal/preview-dns}"
: "${CERTBOT_DOMAIN:?CERTBOT_DOMAIN not set (run via certbot)}"

secret="$(tr -d '\r\n' < "$secret_file")"
body="$(printf '{"domain":"%s","validation":"%s"}' "$CERTBOT_DOMAIN" "${CERTBOT_VALIDATION:-}")"

curl --fail-with-body -sS --max-time 240 \
  -H "Content-Type: application/json" \
  -H "X-Preview-DNS-Secret: ${secret}" \
  -X POST "${base_url}/${action}" \
  --data "$body"
echo
