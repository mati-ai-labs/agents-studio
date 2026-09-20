/** Small, dependency-free utilities. No secrets are ever logged here. */

import { createHash, randomBytes } from "node:crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlOfString(input: string): string {
  return base64url(Buffer.from(input, "utf8"));
}

/** Cryptographically random URL-safe string for OAuth `state`. */
export function randomState(): string {
  return base64url(randomBytes(32));
}

/** PKCE code verifier (RFC 7636) and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier, "ascii").digest());
  return { verifier, challenge };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Parse an ISO/RFC3339 timestamp to a Date, or null if invalid. */
export function parseIso(value: string | undefined | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function toUtcZ(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Coerce an unknown value to a trimmed string, or undefined. */
export function safeStr(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Coerce an unknown value to an array (empty if not an array). */
export function safeArr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Coerce an unknown value to a plain object (empty if not an object). */
export function safeObj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// ANSI CSI sequences + C0 control chars (keep tab \x09 and newline \x0A).
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Strip ANSI escapes and control characters from UNTRUSTED content before
 * printing it to a human-facing terminal. Prevents terminal-injection via
 * crafted note text. Raw content is preserved in JSON output and on disk.
 */
export function sanitizeForTerminal(input: string): string {
  return input.replace(ANSI_RE, "").replace(CONTROL_RE, "");
}

/** Truncate a string for safe display in error messages. */
export function truncate(input: string, max = 300): string {
  return input.length > max ? input.slice(0, max) + "…" : input;
}
