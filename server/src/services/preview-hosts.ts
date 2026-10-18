import type { Db } from "@paperclipai/db";
import { instancePreviewsService } from "./instance-previews.js";

/**
 * Preview subdomains: `<slug>.<preview domain>`. The preview domain lives in
 * instance settings; it is cached here so host matching (also needed in the
 * synchronous WebSocket upgrade path) never waits on the database.
 */

const REFRESH_MS = 30_000;
const SLUG_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

let cachedDomain: string | null = null;
let loadedAt = 0;
let refreshing: Promise<void> | null = null;

export function setCachedPreviewDomain(domain: string | null) {
  cachedDomain = domain ? domain.trim().toLowerCase().replace(/\.$/, "") || null : null;
  loadedAt = Date.now();
}

export function getCachedPreviewDomain(): string | null {
  return cachedDomain;
}

/** Load the domain now (startup) or refresh it in the background when stale. */
export function refreshPreviewDomain(db: Db, opts: { force?: boolean } = {}): Promise<void> {
  if (!opts.force && Date.now() - loadedAt < REFRESH_MS) return Promise.resolve();
  if (refreshing) return refreshing;
  refreshing = instancePreviewsService(db)
    .get()
    .then((settings) => setCachedPreviewDomain(settings.domain))
    .catch(() => {
      loadedAt = Date.now();
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

function hostnameOf(rawHost: string | null | undefined): string | null {
  const first = rawHost?.split(",")[0]?.trim().toLowerCase();
  if (!first) return null;
  try {
    return new URL(`http://${first}`).hostname.replace(/\.$/, "");
  } catch {
    return null;
  }
}

/** The slug when `rawHost` is `<slug>.<domain>`, else null. */
export function matchPreviewHost(rawHost: string | null | undefined, domain = cachedDomain): string | null {
  if (!domain) return null;
  const hostname = hostnameOf(rawHost);
  if (!hostname || !hostname.endsWith(`.${domain}`)) return null;
  const label = hostname.slice(0, -(domain.length + 1));
  return SLUG_LABEL.test(label) ? label : null;
}

export function previewHostOrigin(slug: string, domain: string): string {
  return `https://${slug}.${domain}`;
}

export function buildPreviewHostUrl(slug: string, domain: string): string {
  return `${previewHostOrigin(slug, domain)}/`;
}

/** True for WebSocket upgrades addressed to a preview subdomain. */
export function isPreviewHostUpgrade(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  const raw = req.headers["x-forwarded-host"] ?? req.headers.host;
  return matchPreviewHost(Array.isArray(raw) ? raw[0] : raw) !== null;
}
