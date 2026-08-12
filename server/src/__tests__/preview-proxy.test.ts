import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import {
  buildPreviewUpstreamHeaders,
  parsePreviewRequestTarget,
  previewPathPrefix,
  proxyPreviewHttp,
  rewritePreviewCssReferences,
  rewritePreviewHtml,
  rewritePreviewLocation,
  rewritePreviewModuleReferences,
  rewritePreviewSetCookie,
  stripPaperclipCookies,
} from "../services/preview-proxy.js";
import type { PreviewLeaseWithRuntimeService } from "../services/previews.js";

describe("preview proxy", () => {
  let upstream: Server | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!upstream) {
        resolve();
        return;
      }
      upstream.close(() => resolve());
      upstream = null;
    });
  });

  it("parses only Paperclip preview paths and preserves the upstream path/query", () => {
    expect(parsePreviewRequestTarget("/preview/site-abc/assets/app.js?cache=1")).toEqual({
      slug: "site-abc",
      targetPath: "/assets/app.js",
      search: "?cache=1",
    });
    expect(parsePreviewRequestTarget("/preview/site-abc")).toEqual({
      slug: "site-abc",
      targetPath: "/",
      search: "",
    });
    expect(parsePreviewRequestTarget("/api/health")).toBeNull();
  });

  it("does not forward Paperclip authentication cookies or bearer keys", () => {
    expect(stripPaperclipCookies("paperclip-default.session_token=secret; app=kept")).toBe("app=kept");
    const headers = buildPreviewUpstreamHeaders({
      source: new Headers({
        host: "paperclip.test",
        authorization: "Bearer board-key",
        cookie: "paperclip-default.session_token=secret; app=kept",
      }),
      port: 4173,
      slug: "site-abc",
    });
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBe("app=kept");
    expect(headers.get("host")).toBe("127.0.0.1:4173");
    expect(headers.get("x-forwarded-prefix")).toBe(previewPathPrefix("site-abc"));
  });

  it("rewrites browser-facing root references, redirects, and cookie paths", () => {
    expect(rewritePreviewHtml('<script src="/assets/app.js"></script><a href="/login">Login</a>', "site-abc"))
      .toContain('/preview/site-abc/assets/app.js');
    expect(rewritePreviewLocation("/dashboard?tab=1", "site-abc", "http://127.0.0.1:4173"))
      .toBe("/preview/site-abc/dashboard?tab=1");
    expect(rewritePreviewSetCookie("sid=abc; Domain=localhost; Path=/; HttpOnly", "site-abc"))
      .toBe("sid=abc; Path=/preview/site-abc/; HttpOnly");
  });

  it("rewrites module specifiers without corrupting regex literals or strings", async () => {
    const slug = "site-abc";
    const source = `import x from "/node_modules/foo.js";
import "/src/sideeffect.css";
import { y } from '/src/other.js';
const d = import("/src/dyn.js");
const u = new URL("/assets/pic.png", import.meta.url);
const ignore = [
  /can't redefine non-configurable property "solana"/,
  /random\\/slash "quoted"\\/end/,
];
const msg = "a plain string with /slashes/ inside";
`;
    const rewritten = rewritePreviewModuleReferences(source, slug);

    expect(rewritten).toContain('from "/preview/site-abc/node_modules/foo.js"');
    expect(rewritten).toContain('import "/preview/site-abc/src/sideeffect.css"');
    expect(rewritten).toContain("from '/preview/site-abc/src/other.js'");
    expect(rewritten).toContain('import("/preview/site-abc/src/dyn.js")');
    expect(rewritten).toContain('new URL("/preview/site-abc/assets/pic.png", import.meta.url)');
    // Regex literals and ordinary strings must survive byte-for-byte.
    expect(rewritten).toContain('/can\'t redefine non-configurable property "solana"/');
    expect(rewritten).toContain('"a plain string with /slashes/ inside"');
    // Result must remain valid JavaScript (no "Invalid regular expression flags").
    // `import`/`export` statements are module syntax, so validate via the
    // TypeScript parser (a repo dependency) instead of `new Function`.
    const { createSourceFile, ScriptTarget, ScriptKind } = await import("typescript");
    const diagnostics = createSourceFile(
      "module.js",
      rewritten,
      ScriptTarget.Latest,
      false,
      ScriptKind.JS,
    ).parseDiagnostics;
    expect(diagnostics).toEqual([]);
  });

  it("routes Vite-injected HMR loopback hosts through the preview", () => {
    const rewritten = rewritePreviewModuleReferences(
      'const serverHost = "127.0.0.1:39079/";\nconst directSocketHost = "127.0.0.1:39079/";\nconst keep = "other";',
      "site-abc",
      { upstreamPort: 39079, browserHost: "preview.example.com" },
    );
    expect(rewritten).toContain('const serverHost = "preview.example.com/preview/site-abc/";');
    expect(rewritten).toContain('const directSocketHost = "preview.example.com/preview/site-abc/";');
    expect(rewritten).toContain('const keep = "other";');
    expect(rewritten).not.toContain("127.0.0.1:39079");
  });

  it("rewrites CSS url() references only", () => {
    expect(rewritePreviewCssReferences(
      ".a { background: url(/img/x.png); }\n.b { background-image: url(\"/img/y.png?v=2\"); }",
      "site-abc",
    )).toBe(
      '.a { background: url(/preview/site-abc/img/x.png); }\n.b { background-image: url("/preview/site-abc/img/y.png?v=2"); }',
    );
  });

  it("proxies HTML and request bodies to a registered localhost service", async () => {
    let receivedBody = "";
    let receivedAuth: string | undefined;
    upstream = createServer((req, res) => {
      receivedAuth = req.headers.authorization;
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        receivedBody += chunk;
      });
      req.on("end", () => {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.setHeader("set-cookie", "sid=abc; Path=/; HttpOnly");
        res.end('<html><script src="/assets/app.js"></script></html>');
      });
    });
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("upstream did not bind");

    const preview = {
      lease: { status: "active", slug: "site-abc", expiresAt: new Date(Date.now() + 60_000) },
      runtimeService: { provider: "local_process", port: address.port, status: "running" },
    } as PreviewLeaseWithRuntimeService;
    const app = express();
    app.use(express.json());
    app.use(async (req, res, next) => {
      const target = parsePreviewRequestTarget(req.originalUrl);
      if (!target) return next();
      await proxyPreviewHttp(req, res, preview, target);
    });

    const response = await request(app)
      .post("/preview/site-abc/api/submit")
      .set("Authorization", "Bearer paperclip-key")
      .set("Cookie", "paperclip-default.session_token=secret")
      .send({ ok: true });

    expect(response.status).toBe(200);
    expect(response.text).toContain("/preview/site-abc/assets/app.js");
    expect(response.headers["set-cookie"]).toEqual(["sid=abc; Path=/preview/site-abc/; HttpOnly"]);
    expect(receivedBody).toBe('{"ok":true}');
    expect(receivedAuth).toBeUndefined();
  });
});
