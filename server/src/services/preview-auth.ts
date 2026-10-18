import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { deriveKey } from "../lib/encryption.js";

/**
 * Login for preview subdomains. The Agent Studio session cookie can't reach
 * `<slug>.<preview domain>`, so:
 *   1. the preview host redirects to Agent Studio (`/api/preview-auth/start`);
 *   2. Agent Studio checks the user's company access and redirects back with a
 *      60-second, single-use handoff token;
 *   3. the preview host swaps it for a session cookie scoped to that one host.
 */

export const PREVIEW_AUTH_PATH = "/__agentstudio/preview-auth";
export const PREVIEW_SESSION_COOKIE = "agentstudio_preview";
export const HANDOFF_TTL_MS = 60_000;
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

type TokenKind = "handoff" | "session";

export interface PreviewTokenPayload {
  k: TokenKind;
  /** Preview slug the token is valid for. */
  s: string;
  /** User id. */
  u: string;
  /** Company id. */
  c: string;
  /** Expiry, epoch ms. */
  e: number;
  /** Nonce (handoff tokens are single use). */
  n: string;
}

let signingKey: Buffer | null = null;
function key() {
  signingKey ??= deriveKey("preview-auth-v1");
  return signingKey;
}

/** Test hook. */
export function setPreviewAuthKeyForTests(value: Buffer | null) {
  signingKey = value;
  usedNonces.clear();
}

function sign(body: string) {
  return createHmac("sha256", key()).update(body).digest("base64url");
}

export function issuePreviewToken(
  kind: TokenKind,
  input: { slug: string; userId: string; companyId: string },
  now = Date.now(),
): string {
  const payload: PreviewTokenPayload = {
    k: kind,
    s: input.slug,
    u: input.userId,
    c: input.companyId,
    e: now + (kind === "handoff" ? HANDOFF_TTL_MS : SESSION_TTL_MS),
    n: randomBytes(12).toString("base64url"),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

const usedNonces = new Map<string, number>();

function rememberNonce(nonce: string, expiresAt: number, now: number) {
  for (const [n, exp] of usedNonces) if (exp <= now) usedNonces.delete(n);
  usedNonces.set(nonce, expiresAt);
}

/** Payload when the token is genuine, unexpired, of `kind` and for `slug`; else null. */
export function verifyPreviewToken(
  token: string | null | undefined,
  kind: TokenKind,
  slug: string,
  now = Date.now(),
): PreviewTokenPayload | null {
  if (!token) return null;
  const [body, mac, extra] = token.split(".");
  if (!body || !mac || extra !== undefined) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let payload: PreviewTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PreviewTokenPayload;
  } catch {
    return null;
  }
  if (payload.k !== kind || payload.s !== slug || typeof payload.e !== "number" || payload.e <= now) return null;
  if (kind === "handoff") {
    if (usedNonces.has(payload.n)) return null;
    rememberNonce(payload.n, payload.e, now);
  }
  return payload;
}

export function readCookie(header: string | string[] | undefined, name: string): string | null {
  const raw = Array.isArray(header) ? header.join("; ") : header;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

/** Remove our preview cookie before forwarding cookies to the previewed app. */
export function stripPreviewSessionCookie(value: string | null): string | null {
  if (!value) return null;
  const kept = value
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith(`${PREVIEW_SESSION_COOKIE}=`));
  return kept.length > 0 ? kept.join("; ") : null;
}

export function sessionCookieHeader(token: string, secure: boolean): string {
  return [
    `${PREVIEW_SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/** Only same-origin absolute paths, never `//host` or `/\host`. */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return "/";
  }
  if (value.startsWith(PREVIEW_AUTH_PATH)) return "/";
  return value.slice(0, 2048);
}
