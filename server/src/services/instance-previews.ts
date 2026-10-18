import tls from "node:tls";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, instanceSettings } from "@paperclipai/db";
import { decryptValue, encryptValue } from "../lib/encryption.js";
import { unprocessable } from "../errors.js";

const DEFAULT_SINGLETON_KEY = "default";

export type PreviewDnsProvider = "hostinger";

export interface PreviewEventRecord {
  ok: boolean;
  at: string;
  error: string | null;
}

/** Stored shape of `instance_settings.previews`. The DNS token is encrypted. */
interface StoredInstancePreviews {
  domain?: string | null;
  dnsProvider?: PreviewDnsProvider;
  dnsZone?: string | null;
  dnsTokenEncrypted?: string | null;
  enabledCompanyIds?: string[];
  lastDnsTest?: PreviewEventRecord | null;
  lastChallenge?: PreviewEventRecord | null;
}

export interface InstancePreviewSettings {
  domain: string | null;
  dnsProvider: PreviewDnsProvider;
  dnsZone: string | null;
  dnsTokenConfigured: boolean;
  enabledCompanyIds: string[];
  lastDnsTest: PreviewEventRecord | null;
  lastChallenge: PreviewEventRecord | null;
}

export interface PatchInstancePreviewSettings {
  domain?: string | null;
  dnsZone?: string | null;
  /** New token; `null` clears it; omitted keeps the stored one. */
  dnsToken?: string | null;
  enabledCompanyIds?: string[];
}

export interface PreviewDnsCredentials {
  domain: string;
  zone: string;
  provider: PreviewDnsProvider;
  token: string;
}

export interface PreviewCertificateStatus {
  status: "valid" | "not_issued" | "expired" | "unreachable";
  expiresAt: string | null;
  issuer: string | null;
  error: string | null;
}

export function normalizeHostname(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase().replace(/\.$/, "");
  return trimmed.length > 0 ? trimmed : null;
}

const HOSTNAME_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function readStored(raw: unknown): StoredInstancePreviews {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as StoredInstancePreviews) : {};
}

function toView(stored: StoredInstancePreviews): InstancePreviewSettings {
  return {
    domain: normalizeHostname(stored.domain),
    dnsProvider: stored.dnsProvider ?? "hostinger",
    dnsZone: normalizeHostname(stored.dnsZone),
    dnsTokenConfigured: typeof stored.dnsTokenEncrypted === "string" && stored.dnsTokenEncrypted.length > 0,
    enabledCompanyIds: Array.isArray(stored.enabledCompanyIds)
      ? stored.enabledCompanyIds.filter((id): id is string => typeof id === "string")
      : [],
    lastDnsTest: stored.lastDnsTest ?? null,
    lastChallenge: stored.lastChallenge ?? null,
  };
}

function validateDomainInZone(domain: string | null, zone: string | null) {
  if (domain && !HOSTNAME_PATTERN.test(domain)) throw unprocessable(`Invalid preview domain: ${domain}`);
  if (zone && !HOSTNAME_PATTERN.test(zone)) throw unprocessable(`Invalid DNS zone: ${zone}`);
  if (domain && zone && domain !== zone && !domain.endsWith(`.${zone}`)) {
    throw unprocessable(`Preview domain ${domain} must be inside DNS zone ${zone}`);
  }
}

/**
 * Read the certificate nginx serves for `*.<domain>` by opening a TLS
 * connection with a probe SNI name. No file access to /etc/letsencrypt needed.
 */
export function inspectPreviewCertificate(
  domain: string,
  opts: { host?: string; port?: number; timeoutMs?: number; now?: Date } = {},
): Promise<PreviewCertificateStatus> {
  const host = opts.host ?? process.env.PAPERCLIP_PREVIEW_TLS_PROBE_HOST ?? "127.0.0.1";
  const port = opts.port ?? 443;
  return new Promise((resolve) => {
    const socket = tls.connect({
      host,
      port,
      servername: `status-check.${domain}`,
      rejectUnauthorized: false,
      timeout: opts.timeoutMs ?? 5_000,
    });
    const done = (status: PreviewCertificateStatus) => {
      socket.destroy();
      resolve(status);
    };
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      const san = typeof cert?.subjectaltname === "string" ? cert.subjectaltname.toLowerCase() : "";
      const expiresAt = cert?.valid_to ? new Date(cert.valid_to).toISOString() : null;
      const issuer = typeof cert?.issuer?.O === "string" ? cert.issuer.O : (cert?.issuer?.CN as string | undefined) ?? null;
      if (!san.split(/,\s*/).includes(`dns:*.${domain}`)) {
        done({ status: "not_issued", expiresAt: null, issuer: null, error: null });
        return;
      }
      const expired = expiresAt !== null && new Date(expiresAt).getTime() <= (opts.now ?? new Date()).getTime();
      done({ status: expired ? "expired" : "valid", expiresAt, issuer, error: null });
    });
    socket.once("timeout", () => done({ status: "unreachable", expiresAt: null, issuer: null, error: "TLS probe timed out" }));
    socket.once("error", (err) => done({ status: "unreachable", expiresAt: null, issuer: null, error: err.message }));
  });
}

export function instancePreviewsService(db: Db) {
  async function getRow() {
    const row = await db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
    if (row) return row;
    const now = new Date();
    const [created] = await db
      .insert(instanceSettings)
      .values({ singletonKey: DEFAULT_SINGLETON_KEY, general: {}, experimental: {}, previews: {}, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: [instanceSettings.singletonKey], set: { updatedAt: now } })
      .returning();
    return created;
  }

  async function writeStored(id: string, next: StoredInstancePreviews) {
    await db
      .update(instanceSettings)
      .set({ previews: { ...next } as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(instanceSettings.id, id));
  }

  async function patchStored(mutate: (current: StoredInstancePreviews) => StoredInstancePreviews) {
    const row = await getRow();
    const next = mutate(readStored(row.previews));
    await writeStored(row.id, next);
    return toView(next);
  }

  return {
    get: async (): Promise<InstancePreviewSettings> => toView(readStored((await getRow()).previews)),

    update: async (patch: PatchInstancePreviewSettings): Promise<InstancePreviewSettings> =>
      patchStored((current) => {
        const next: StoredInstancePreviews = { ...current, dnsProvider: "hostinger" };
        if (patch.domain !== undefined) next.domain = normalizeHostname(patch.domain);
        if (patch.dnsZone !== undefined) next.dnsZone = normalizeHostname(patch.dnsZone);
        validateDomainInZone(normalizeHostname(next.domain), normalizeHostname(next.dnsZone));
        if (patch.dnsToken !== undefined) {
          const token = patch.dnsToken?.trim() ?? "";
          next.dnsTokenEncrypted = token ? encryptValue(token) : null;
          next.lastDnsTest = null;
        }
        if (patch.enabledCompanyIds !== undefined) {
          next.enabledCompanyIds = Array.from(new Set(patch.enabledCompanyIds));
        }
        return next;
      }),

    isCompanyEnabled: async (companyId: string): Promise<boolean> => {
      const view = toView(readStored((await getRow()).previews));
      return view.domain !== null && view.enabledCompanyIds.includes(companyId);
    },

    /** Domain, zone and decrypted token, or null when previews DNS isn't fully configured. */
    getDnsCredentials: async (): Promise<PreviewDnsCredentials | null> => {
      const stored = readStored((await getRow()).previews);
      const domain = normalizeHostname(stored.domain);
      const zone = normalizeHostname(stored.dnsZone);
      if (!domain || !zone || !stored.dnsTokenEncrypted) return null;
      const token = decryptValue(stored.dnsTokenEncrypted).trim();
      if (!token) return null;
      return { domain, zone, provider: stored.dnsProvider ?? "hostinger", token };
    },

    recordEvent: async (kind: "lastDnsTest" | "lastChallenge", event: PreviewEventRecord) => {
      await patchStored((current) => ({ ...current, [kind]: event }));
    },

    listCompanies: async () =>
      db
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .then((rows) => rows.sort((a, b) => a.name.localeCompare(b.name))),
  };
}
