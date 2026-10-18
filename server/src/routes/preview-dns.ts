import { randomBytes, timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest, forbidden, notFound, unprocessable } from "../errors.js";
import { instancePreviewsService, type PreviewDnsCredentials } from "../services/instance-previews.js";
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
 * loopback. Domain, zone and the encrypted DNS token come from
 * Instance Settings → Previews; only the hook secret lives in host config:
 *
 *   PAPERCLIP_PREVIEW_DNS_HOOK_SECRET  shared secret sent by the certbot hook
 */

export interface PreviewDnsRouteOptions {
  readHookSecret?: () => string | null;
  readCredentials?: () => Promise<PreviewDnsCredentials | null>;
  recordChallenge?: (event: { ok: boolean; at: string; error: string | null }) => Promise<void>;
  waitForTxt?: typeof waitForAuthoritativeTxt;
  fetchImpl?: typeof fetch;
}

function normalizeDomain(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/\.$/, "") : "";
}

function readHookSecretFromEnv(): string | null {
  const secret = process.env.PAPERCLIP_PREVIEW_DNS_HOOK_SECRET?.trim();
  return secret ? secret : null;
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

/** `<label>.<domain>` expressed relative to the zone, e.g. `_acme-challenge.preview`. */
export function recordNameInZone(label: string, domain: string, zone: string): string {
  const fqdn = `${label}.${domain}`;
  if (fqdn === zone || !fqdn.endsWith(`.${zone}`)) {
    throw unprocessable(`Domain ${domain} is not inside DNS zone ${zone}`);
  }
  return fqdn.slice(0, -(zone.length + 1));
}

/** Present a TXT record, wait until authoritative NS serve it, then remove it. */
export async function runPreviewDnsTest(
  creds: PreviewDnsCredentials,
  opts: { waitForTxt?: typeof waitForAuthoritativeTxt; fetchImpl?: typeof fetch } = {},
): Promise<{ ok: boolean; record: string; error: string | null }> {
  const waitForTxt = opts.waitForTxt ?? waitForAuthoritativeTxt;
  const label = "_agentstudio-dns-test";
  const name = recordNameInZone(label, creds.domain, creds.zone);
  const record = `${name}.${creds.zone}`;
  const value = `agentstudio-test-${randomBytes(8).toString("hex")}`;
  const client = { token: creds.token, fetchImpl: opts.fetchImpl };
  try {
    await addHostingerTxtRecord(client, creds.zone, name, value);
    const visible = await waitForTxt(creds.zone, `${label}.${creds.domain}`, value, { timeoutMs: 120_000 });
    if (!visible) return { ok: false, record, error: "Record was accepted but did not appear on the authoritative nameservers within 120s" };
    return { ok: true, record, error: null };
  } catch (err) {
    return { ok: false, record, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await deleteHostingerTxtRecords(client, creds.zone, name).catch(() => undefined);
  }
}

export function previewDnsRoutes(db: Db, opts: PreviewDnsRouteOptions = {}) {
  const router = Router();
  const previews = instancePreviewsService(db);
  const readHookSecret = opts.readHookSecret ?? readHookSecretFromEnv;
  const readCredentials = opts.readCredentials ?? (() => previews.getDnsCredentials());
  const recordChallenge = opts.recordChallenge ?? ((event) => previews.recordEvent("lastChallenge", event));
  const waitForTxt = opts.waitForTxt ?? waitForAuthoritativeTxt;

  router.post("/internal/preview-dns/:action", async (req, res) => {
    const hookSecret = readHookSecret();
    if (!hookSecret) throw notFound();
    if (!isDirectLoopbackRequest(req) || !secretMatches(req.header("x-preview-dns-secret"), hookSecret)) {
      throw forbidden();
    }
    const action = req.params.action;
    if (action !== "present" && action !== "cleanup") throw notFound();

    const creds = await readCredentials();
    if (!creds) throw unprocessable("Previews DNS is not configured (Instance Settings → Previews)");

    // certbot passes CERTBOT_DOMAIN without the "*." for wildcard names.
    const domain = normalizeDomain(req.body?.domain).replace(/^\*\./, "");
    if (domain !== creds.domain) {
      throw forbidden(`Only ${creds.domain} challenges are allowed`);
    }
    const validation = typeof req.body?.validation === "string" ? req.body.validation.trim() : "";
    if (action === "present" && !validation) throw badRequest("validation is required");

    const name = recordNameInZone("_acme-challenge", domain, creds.zone);
    const client = { token: creds.token, fetchImpl: opts.fetchImpl };
    if (action === "present") {
      try {
        await addHostingerTxtRecord(client, creds.zone, name, validation);
        const visible = await waitForTxt(creds.zone, `_acme-challenge.${domain}`, validation);
        if (!visible) throw unprocessable(`TXT record ${name}.${creds.zone} did not appear on authoritative nameservers`);
      } catch (err) {
        await recordChallenge({ ok: false, at: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
      await recordChallenge({ ok: true, at: new Date().toISOString(), error: null });
      res.json({ ok: true, record: `${name}.${creds.zone}` });
      return;
    }
    await deleteHostingerTxtRecords(client, creds.zone, name);
    res.json({ ok: true, record: `${name}.${creds.zone}` });
  });

  return router;
}
