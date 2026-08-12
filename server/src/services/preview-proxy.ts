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

/**
 * Vite (and most dev bundlers) emit absolute root-relative imports inside
 * JavaScript and CSS responses, not only in the HTML shell. Those imports
 * must stay inside the lease prefix or the browser requests them from the
 * Paperclip root and receives the control-plane HTML document instead.
 *
 * IMPORTANT: this must NOT be a blind `quote + "/"` string rewrite. Dependency
 * bundles contain regex literals, template literals, and comments that are
 * legitimately full of `"/"` sequences (e.g. `/can't redefine ... "solana"/`).
 * A global regex corrupts those into `"solana"/preview/<slug>/` and produces
 * `Invalid regular expression flags`, blank pages, and broken HMR. We therefore
 * lex the source and rewrite ONLY:
 *   - static import/export module specifiers (`from "/x"`, `import "/x"`,
 *     `export ... from "/x"`),
 *   - dynamic `import("/x")` specifiers,
 *   - `new URL("/x", import.meta.url)` asset references,
 *   - Vite-injected HMR server hosts (`127.0.0.1:<port>/` / `localhost:<port>/`)
 *     so the browser connects through the preview instead of the loopback.
 * Regex literals, comments, template contents, arbitrary strings, and source
 * maps are never rewritten.
 */
type RewriteModuleToken =
  | { kind: "id" | "kw" | "num" | "str" | "template" | "regex"; value: string }
  | { kind: "punct"; value: string };

function regexAllowedAfter(previous: RewriteModuleToken | undefined): boolean {
  if (!previous) return true;
  if (previous.kind === "punct") {
    return !(previous.value === ")" || previous.value === "]" || previous.value === "}" || previous.value === "++" || previous.value === "--");
  }
  return false;
}

function isModuleSpecifierString(history: RewriteModuleToken[]): boolean {
  const last = history[history.length - 1];
  if (!last) return false;
  if ((last.kind === "id" || last.kind === "kw") && last.value === "from") return true;
  if (last.kind === "kw" && (last.value === "import" || last.value === "export")) return true;
  if (last.kind === "punct" && last.value === "(") {
    const prev = history[history.length - 2];
    if (!prev) return false;
    if (prev.kind === "kw" && prev.value === "import") return true;
    if (prev.kind === "id" && prev.value === "URL") {
      const prev3 = history[history.length - 3];
      return !!(prev3 && prev3.kind === "kw" && prev3.value === "new");
    }
  }
  return false;
}

const HMR_LOOPBACK_RE = /^(?:127\.0\.0\.1|localhost):(\d+)\/?$/;

export function rewritePreviewModuleReferences(
  source: string,
  slug: string,
  opts?: { upstreamPort?: number; browserHost?: string | null },
): string {
  const prefix = previewPathPrefix(slug);
  const out: string[] = [];
  let i = 0;
  const n = source.length;
  const history: RewriteModuleToken[] = [];

  const pushToken = (token: RewriteModuleToken) => {
    history.push(token);
    if (history.length > 32) history.shift();
  };

  while (i < n) {
    const c = source[i];

    // Whitespace
    if (/\s/.test(c)) {
      out.push(c);
      i++;
      continue;
    }

    // Line comment
    if (c === "/" && source[i + 1] === "/") {
      const j = source.indexOf("\n", i);
      const end = j === -1 ? n : j;
      out.push(source.slice(i, end));
      i = end;
      continue;
    }

    // Block comment
    if (c === "/" && source[i + 1] === "*") {
      const j = source.indexOf("*/", i + 2);
      const end = j === -1 ? n : j + 2;
      out.push(source.slice(i, end));
      i = end;
      continue;
    }

    // String literal (single or double quote)
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      while (j < n && source[j] !== quote) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        j++;
      }
      const end = j < n ? j + 1 : n;
      const raw = source.slice(i, end);
      let rewritten = raw;
      const inner = raw.slice(1, raw.length - 1);

      if (isModuleSpecifierString(history)) {
        if (inner.startsWith("/") && !inner.startsWith("//") && !inner.startsWith(prefix)) {
          rewritten = quote + prefix + inner + quote;
        }
      } else if (opts?.browserHost && opts.upstreamPort && HMR_LOOPBACK_RE.test(inner)) {
        const match = HMR_LOOPBACK_RE.exec(inner)!;
        if (Number(match[1]) === opts.upstreamPort) {
          rewritten = quote + `${opts.browserHost}${prefix}/` + quote;
        }
      }

      out.push(rewritten);
      pushToken({ kind: "str", value: "s" });
      i = end;
      continue;
    }

    // Template literal — never rewrite contents; just skip over it (incl. ${}).
    if (c === "`") {
      let j = i + 1;
      let depth = 0;
      let s = "`";
      while (j < n) {
        if (source[j] === "\\") {
          s += source.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (source[j] === "$" && source[j + 1] === "{") {
          depth++;
          s += "${";
          j += 2;
          continue;
        }
        if (source[j] === "}" && depth > 0) {
          depth--;
          s += "}";
          j++;
          continue;
        }
        if (source[j] === "`" && depth === 0) {
          s += "`";
          j++;
          break;
        }
        s += source[j];
        j++;
      }
      out.push(s);
      pushToken({ kind: "template", value: "t" });
      i = j;
      continue;
    }

    // Regex literal (only when in expression position).
    if (c === "/" && regexAllowedAfter(history[history.length - 1])) {
      let j = i + 1;
      let k = j;
      let closed = false;
      while (k < n && source[k] !== "\n") {
        if (source[k] === "\\") {
          k += 2;
          continue;
        }
        if (source[k] === "[") {
          k++;
          while (k < n && source[k] !== "]" && source[k] !== "\n") {
            if (source[k] === "\\") k += 2;
            else k++;
          }
          k++;
          continue;
        }
        if (source[k] === "/") {
          closed = true;
          break;
        }
        k++;
      }
      if (closed) {
        let e = k + 1;
        while (e < n && /[a-z]/i.test(source[e])) e++;
        out.push(source.slice(i, e));
        pushToken({ kind: "regex", value: "r" });
        i = e;
        continue;
      }
      // Division operator — treat as plain punctuation.
      out.push(c);
      i++;
      continue;
    }

    // Identifier / keyword
    if (/[A-Za-z_$]/.test(c) || c.charCodeAt(0) > 127) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(source[j])) j++;
      const word = source.slice(i, j);
      const keywords = new Set([
        "import", "from", "export", "new", "const", "let", "var", "function",
        "return", "if", "else", "class", "async", "await", "of", "in",
        "typeof", "instanceof", "throw", "try", "catch", "finally", "switch",
        "case", "default", "break", "continue", "delete", "void", "this",
        "super", "extends", "yield", "static", "get", "set", "do", "while",
        "for", "with", "debugger", "true", "false", "null", "undefined",
      ]);
      out.push(word);
      pushToken({ kind: keywords.has(word) ? "kw" : "id", value: word });
      i = j;
      continue;
    }

    // Number
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9a-fA-FxXoObB.eE_+-]/.test(source[j])) j++;
      out.push(source.slice(i, j));
      pushToken({ kind: "num", value: "n" });
      i = j;
      continue;
    }

    // Punctuation (including ++ / --)
    if ("(){}[];,<>=!+-*%&|^~?:.".includes(c)) {
      let tok = c;
      if ((c === "+" && source[i + 1] === "+") || (c === "-" && source[i + 1] === "-")) {
        tok = c + c;
      }
      out.push(tok);
      pushToken({ kind: "punct", value: tok });
      i += tok.length;
      continue;
    }

    // Anything else (rare unicode operators, etc.) — pass through untouched.
    out.push(c);
    i++;
  }

  return out.join("");
}

/**
 * Rewrite root-relative `url(...)` references in CSS responses so they stay
 * inside the preview lease prefix. CSS has no regex literals, so a targeted
 * url()-anchored rewrite is safe (it cannot corrupt JS-style literals).
 */
export function rewritePreviewCssReferences(source: string, slug: string): string {
  const prefix = previewPathPrefix(slug);
  return source.replace(
    /(url\(\s*["']?)\/(?!\/|preview\/)/gi,
    (_match, start: string) => `${start}${prefix}/`,
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
  const rewriteHtml = contentType.includes("text/html");
  const rewriteJs =
    contentType.includes("javascript") || contentType.includes("ecmascript");
  const rewriteCss = contentType.includes("text/css");
  const rewriteBody = rewriteHtml || rewriteJs || rewriteCss;
  res.status(response.status);
  res.setHeader("Cache-Control", "no-store");
  copyPreviewResponseHeaders(response, res, target.slug, targetOrigin, rewriteBody);

  if (!response.body || req.method.toUpperCase() === "HEAD" || response.status === 204 || response.status === 304) {
    res.end();
    return;
  }

  if (rewriteHtml) {
    const html = await response.text();
    res.end(rewritePreviewHtml(html, target.slug));
    return;
  }

  if (rewriteJs) {
    const source = await response.text();
    const forwardedHost = req.headers["x-forwarded-host"];
    const hostHeader = req.headers["host"];
    const browserHost =
      (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)?.split(",")[0]?.trim() ||
      (Array.isArray(hostHeader) ? hostHeader[0] : hostHeader)?.split(",")[0]?.trim() ||
      null;
    res.end(rewritePreviewModuleReferences(source, target.slug, { upstreamPort: port, browserHost }));
    return;
  }

  if (rewriteCss) {
    const css = await response.text();
    res.end(rewritePreviewCssReferences(css, target.slug));
    return;
  }

  Readable.fromWeb(response.body as any).pipe(res);
}
