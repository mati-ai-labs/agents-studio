import { timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest, forbidden, notFound, unprocessable } from "../errors.js";
import { connectorRegistryService } from "../services/connector-registry.js";
import {
  addHostingerTxtRecord,
  deleteHostingerTxtRecords,
  waitForAuthoritativeTxt,
} from "../services/hostinger-dns.js";

/**
 * Internal DNS-01 challenge endpoint for the preview wildcard certificate.
 *
 * certbot runs on the host with `--manual-auth-hook` / `--manual-cleanup-hook`
 * pointing at scripts/preview-dns-certbot-hook.sh, which calls this route over
 * loopback. The Hostinger API token never leaves this process: it is read from
 * the configured company's Hostinger connector.
 *
 * Instance env:
 *   PAPERCLIP_PREVIEW_DOMAIN           e.g. preview.matilabs.com
 *   PAPERCLIP_PREVIEW_DNS_ZONE         Hostinger zone, e.g. matilabs.com
 *   PAPERCLIP_PREVIEW_DNS_COMPANY_ID   company whose Hostinger connector manages the zone
 *   PAPERCLIP_PREVIEW_DNS_HOOK_SECRET  shared secret sent by the certbot hook
 */

interface PreviewDnsConfig {
  previewDomain: string;
  zone: string;
  companyId: string;
  hookSecret: string;
}

export interface PreviewDnsRouteOptions {
  readConfig?: () => PreviewDnsConfig | null;
  waitForTxt?: typeof waitForAuthoritativeTxt;
  fetchImpl?: typeof fetch;
}

function normalizeDomain(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/\.$/, "") : "";
}

export function readPreviewDnsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PreviewDnsConfig | null {
  const previewDomain = normalizeDomain(env.PAPERCLIP_PREVIEW_DOMAIN);
  const zone = normalizeDomain(env.PAPERCLIP_PREVIEW_DNS_ZONE);
  const companyId = env.PAPERCLIP_PREVIEW_DNS_COMPANY_ID?.trim() ?? "";
  const hookSecret = env.PAPERCLIP_PREVIEW_DNS_HOOK_SECRET?.trim() ?? "";
  if (!previewDomain || !zone || !companyId || !hookSecret) return null;
  return { previewDomain, zone, companyId, hookSecret };
}

function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function isDirectLoopbackRequest(req: Request): boolean {
  // nginx always sets X-Real-IP / X-Forwarded-For, and proxies from loopback,
  // so a proxied request must not count as local.
  if (req.header("x-real-ip") || req.header("x-forwarded-for")) return false;
  const addr = req.socket.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/** `_acme-challenge.<domain>` expressed relative to the zone, e.g. `_acme-challenge.preview`. */
export function challengeRecordName(domain: string, zone: string): string {
  const fqdn = `_acme-challenge.${domain}`;
  if (fqdn === zone || !fqdn.endsWith(`.${zone}`)) {
    throw unprocessable(`Domain ${domain} is not inside DNS zone ${zone}`);
  }
  return fqdn.slice(0, -(zone.length + 1));
}

export function previewDnsRoutes(db: Db, opts: PreviewDnsRouteOptions = {}) {
  const router = Router();
  const registry = connectorRegistryService(db);
  const readConfig = opts.readConfig ?? (() => readPreviewDnsConfigFromEnv());
  const waitForTxt = opts.waitForTxt ?? waitForAuthoritativeTxt;

  router.post("/internal/preview-dns/:action", async (req, res) => {
    const config = readConfig();
    if (!config) throw notFound();
    if (!isDirectLoopbackRequest(req) || !secretMatches(req.header("x-preview-dns-secret"), config.hookSecret)) {
      throw forbidden();
    }
    const action = req.params.action;
    if (action !== "present" && action !== "cleanup") throw notFound();

    // certbot passes CERTBOT_DOMAIN without the "*." for wildcard names.
    const domain = normalizeDomain(req.body?.domain).replace(/^\*\./, "");
    if (domain !== config.previewDomain) {
      throw forbidden(`Only ${config.previewDomain} challenges are allowed`);
    }
    const validation = typeof req.body?.validation === "string" ? req.body.validation.trim() : "";
    if (action === "present" && !validation) throw badRequest("validation is required");

    const lookup = await registry.getCredentialsForAgentAsync(config.companyId, "hostinger");
    const token = lookup?.credentials.accessToken?.trim();
    if (!token) throw unprocessable("Hostinger connector is not connected for the preview DNS company");

    const name = challengeRecordName(domain, config.zone);
    const client = { token, fetchImpl: opts.fetchImpl };
    if (action === "present") {
      await addHostingerTxtRecord(client, config.zone, name, validation);
      const visible = await waitForTxt(config.zone, `_acme-challenge.${domain}`, validation);
      if (!visible) throw unprocessable(`TXT record ${name}.${config.zone} did not appear on authoritative nameservers`);
      res.json({ ok: true, record: `${name}.${config.zone}` });
      return;
    }
    await deleteHostingerTxtRecords(client, config.zone, name);
    res.json({ ok: true, record: `${name}.${config.zone}` });
  });

  return router;
}
