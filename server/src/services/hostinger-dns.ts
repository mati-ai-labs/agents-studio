import { promises as dnsPromises } from "node:dns";

const HOSTINGER_API_BASE = "https://developers.hostinger.com";

export interface HostingerDnsClientOptions {
  token: string;
  fetchImpl?: typeof fetch;
}

async function hostingerRequest(
  opts: HostingerDnsClientOptions,
  method: "PUT" | "DELETE",
  zone: string,
  body: unknown,
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${HOSTINGER_API_BASE}/api/dns/v1/zones/${encodeURIComponent(zone)}`, {
    method,
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Hostinger DNS ${method} ${zone} failed with HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
}

/**
 * Append a TXT value at `name` (relative to `zone`). Uses overwrite=false so
 * other TXT values at the same name (e.g. the second value of a SAN cert
 * challenge) are kept.
 */
export async function addHostingerTxtRecord(
  opts: HostingerDnsClientOptions,
  zone: string,
  name: string,
  value: string,
  ttl = 60,
): Promise<void> {
  await hostingerRequest(opts, "PUT", zone, {
    overwrite: false,
    zone: [{ name, type: "TXT", ttl, records: [{ content: value }] }],
  });
}

/** Delete every TXT value at `name` (relative to `zone`). */
export async function deleteHostingerTxtRecords(
  opts: HostingerDnsClientOptions,
  zone: string,
  name: string,
): Promise<void> {
  await hostingerRequest(opts, "DELETE", zone, {
    filters: [{ name, type: "TXT" }],
  });
}

/**
 * Poll the zone's authoritative nameservers until `fqdn` serves a TXT record
 * containing `value`, so the ACME server never validates before the record
 * exists. Returns false on timeout.
 */
export async function waitForAuthoritativeTxt(
  zone: string,
  fqdn: string,
  value: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? 5_000;
  const nameservers = await dnsPromises.resolveNs(zone);
  const ips = (await Promise.all(nameservers.map((ns) => dnsPromises.resolve4(ns).catch(() => [] as string[])))).flat();
  if (ips.length === 0) throw new Error(`No authoritative nameserver IPs found for ${zone}`);
  const resolver = new dnsPromises.Resolver();
  resolver.setServers(ips);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const records = await resolver.resolveTxt(fqdn).catch(() => [] as string[][]);
    if (records.some((chunks) => chunks.join("") === value)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}
