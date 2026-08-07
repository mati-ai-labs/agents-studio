import { Readable } from "node:stream";
import type { IncomingHttpHeaders } from "node:http";
import type { Request, Response } from "express";
import type { PreviewLeaseWithRuntimeService } from "./previews.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

export interface PreviewRequestTarget {
  slug: string;
  targetPath: string;
  search: string;
}

function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function parsePreviewRequestTarget(rawUrl: string): PreviewRequestTarget | null {
  let url: URL;
  try {
    url = new URL(rawUrl, "http://paperclip-preview.local");
  } catch {
    return null;
  }

  const segments = url.pathname.split("/");
  if (segments[1] !== "preview" || !segments[2]) return null;
  const slug = decodePathSegment(segments[2]);
  if (!slug || !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(slug)) return null;

  const remainder = segments.slice(3).join("/");
  const targetPath = remainder.length > 0 ? `/${remainder}` : "/";
  return {
    slug,
    targetPath: targetPath.startsWith("//") ? `/${targetPath.replace(/^\/+/, "")}` : targetPath,
    search: url.search,
  };
}

export function previewPathPrefix(slug: string): string {
  return `/preview/${encodeURIComponent(slug)}`;
}

export function buildPreviewUpstreamUrl(port: number, target: Pick<PreviewRequestTarget, "targetPath" | "search">): string {
  return `http://127.0.0.1:${port}${target.targetPath}${target.search}`;
}

export function stripPaperclipCookies(value: string | null | undefined): string | null {
  if (!value) return null;
  const kept = value
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .filter((part) => !/^paperclip-[^=;]+=/i.test(part));
  return kept.length > 0 ? kept.join("; ") : null;
}

export function headersFromIncomingHttpHeaders(rawHeaders: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(rawHeaders)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
    } else {
      headers.set(key, raw);
    }
  }
  return headers;
}

export function buildPreviewUpstreamHeaders(input: {
  source: Headers;
  port: number;
  slug: string;
  forwardedFor?: string | null;
}): Headers {
  const headers = new Headers();
  for (const [key, value] of input.source.entries()) {
    const normalized = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized)) continue;
    if (normalized === "host" || normalized === "content-length" || normalized === "authorization") continue;
    if (normalized === "cookie") {
      const cookie = stripPaperclipCookies(value);
      if (cookie) headers.set("cookie", cookie);
      continue;
    }
    if (normalized.startsWith("x-forwarded-") || normalized === "x-paperclip-preview") continue;
    headers.set(key, value);
  }

  const forwardedHost = input.source.get("x-forwarded-host") || input.source.get("host");
  const forwardedProto = input.source.get("x-forwarded-proto") || "http";
  headers.set("host", `127.0.0.1:${input.port}`);
  if (forwardedHost) headers.set("x-forwarded-host", forwardedHost.split(",")[0]!.trim());
  headers.set("x-forwarded-proto", forwardedProto.split(",")[0]!.trim());
  if (input.forwardedFor) headers.set("x-forwarded-for", input.forwardedFor);
  headers.set("x-forwarded-prefix", previewPathPrefix(input.slug));
  headers.set("x-paperclip-preview", input.slug);
  // Node fetch transparently decompresses upstream responses. Requesting identity keeps
  // response headers and bodies consistent when HTML is rewritten below.
  headers.set("accept-encoding", "identity");
  return headers;
}

function previewTargetUrl(slug: string, value: string, targetOrigin: string): string {
  const prefix = previewPathPrefix(slug);
  if (value === prefix || value.startsWith(`${prefix}/`)) return value;

  let parsed: URL;
  try {
    parsed = new URL(value, targetOrigin);
  } catch {
    return value;
  }
  if (parsed.origin !== targetOrigin) return value;
  return `${prefix}${parsed.pathname === "/" ? "/" : parsed.pathname}${parsed.search}${parsed.hash}`;
}

export function rewritePreviewLocation(value: string, slug: string, targetOrigin: string): string {
  return previewTargetUrl(slug, value, targetOrigin);
}

export function rewritePreviewSetCookie(value: string, slug: string): string {
  const prefix = previewPathPrefix(slug);
  const withoutDomain = value.replace(/;\s*Domain=[^;]*/gi, "");
  return withoutDomain.replace(/;\s*Path=([^;]*)/i, (_match, rawPath: string) => {
    const path = rawPath.trim() || "/";
    if (path === "/") return `; Path=${prefix}/`;
    if (path === prefix || path.startsWith(`${prefix}/`)) return `; Path=${path}`;
    return `; Path=${prefix}${path.startsWith("/") ? path : `/${path}`}`;
  });
}

export function rewritePreviewHtml(html: string, slug: string): string {
  const prefix = previewPathPrefix(slug);
  const prefixRootReference = (_match: string, start: string) => `${start}${prefix}/`;
  let rewritten = html.replace(
    /((?:href|src|action|poster|data-src)\s*=\s*["'])\/(?!\/|preview\/)/gi,
    prefixRootReference,
  );
  rewritten = rewritten.replace(
    /((?:fetch|import)\s*\(\s*["'])\/(?!\/|preview\/)/gi,
    prefixRootReference,
  );
  return rewritten.replace(
    /(url\(\s*["']?)\/(?!\/|preview\/)/gi,
    prefixRootReference,
  );
}

function getSetCookies(headers: Headers): string[] {
  const withAccessor = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withAccessor.getSetCookie === "function") return withAccessor.getSetCookie();
  const combined = headers.get("set-cookie");
  if (!combined) return [];
  return combined.split(/,(?=\s*[^;,=]+\s*=)/g);
}

function copyPreviewResponseHeaders(response: globalThis.Response, res: Response, slug: string, targetOrigin: string, rewriteBody: boolean) {
  for (const [key, value] of response.headers.entries()) {
    const normalized = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized) || normalized === "set-cookie" || normalized === "location") continue;
    if (rewriteBody && (normalized === "content-length" || normalized === "content-encoding")) continue;
    res.setHeader(key, value);
  }

  const location = response.headers.get("location");
  if (location) {
    res.setHeader("location", rewritePreviewLocation(location, slug, targetOrigin));
  }

  const setCookies = getSetCookies(response.headers)
    .map((cookie) => rewritePreviewSetCookie(cookie, slug));
  if (setCookies.length > 0) res.setHeader("set-cookie", setCookies);
}

function requestBody(req: Request): unknown {
  if (BODYLESS_METHODS.has(req.method.toUpperCase())) return undefined;
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (rawBody && rawBody.length > 0) return rawBody;
  if (req.body !== undefined) {
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === "string") return req.body;
    return Buffer.from(JSON.stringify(req.body));
  }
  if (!req.readableEnded && req.readable) return req;
  return undefined;
}

export async function proxyPreviewHttp(
  req: Request,
  res: Response,
  preview: PreviewLeaseWithRuntimeService,
  target: PreviewRequestTarget,
) {
  const port = preview.runtimeService.port;
  if (
    preview.runtimeService.provider !== "local_process" ||
    !port ||
    port < 1 ||
    port > 65_535 ||
    preview.runtimeService.status !== "running"
  ) {
    res.status(503).json({ error: "Preview runtime service is not running" });
    return;
  }

  const targetOrigin = `http://127.0.0.1:${port}`;
  const sourceHeaders = headersFromIncomingHttpHeaders(req.headers);
  const headers = buildPreviewUpstreamHeaders({
    source: sourceHeaders,
    port,
    slug: target.slug,
    forwardedFor: req.socket.remoteAddress,
  });
  const body = requestBody(req);
  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers,
    redirect: "manual",
  };
  if (body !== undefined) {
    init.body = body as BodyInit;
    init.duplex = "half";
  }

  let response: globalThis.Response;
  try {
    response = await fetch(buildPreviewUpstreamUrl(port, target), init);
  } catch (error) {
    res.status(502).json({
      error: "Preview upstream is unavailable",
      details: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const rewriteBody = contentType.includes("text/html");
  res.status(response.status);
  res.setHeader("Cache-Control", "no-store");
  copyPreviewResponseHeaders(response, res, target.slug, targetOrigin, rewriteBody);

  if (!response.body || req.method.toUpperCase() === "HEAD" || response.status === 204 || response.status === 304) {
    res.end();
    return;
  }

  if (rewriteBody) {
    const html = await response.text();
    res.end(rewritePreviewHtml(html, target.slug));
    return;
  }

  Readable.fromWeb(response.body as any).pipe(res);
}
