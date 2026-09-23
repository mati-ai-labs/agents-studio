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

  it("rewrites srcset/imagesrcset/lazy-load attributes and preserves data:/external entries", () => {
    expect(
      rewritePreviewHtml(
        '<img srcset="/img/a.png 1x, /img/b.png 2x" imagesrcset="/img/c.png 640w">' +
          '<img data-srcset="/img/d.png 480w" data-src="/img/e.png">' +
          '<img data-lazy-src="/img/f.png">' +
          '<picture><img srcset="data:image/png;base64,AA/BB 1x, https://cdn.example.com/x.png 2x, //cdn.example.com/bg.png 3x"></picture>' +
          '<img src="/logo.png" data-original="/img/g.png">',
        "site-abc",
      ),
    ).toBe(
      '<img srcset="/preview/site-abc/img/a.png 1x, /preview/site-abc/img/b.png 2x" ' +
        'imagesrcset="/preview/site-abc/img/c.png 640w">' +
        '<img data-srcset="/preview/site-abc/img/d.png 480w" data-src="/preview/site-abc/img/e.png">' +
        '<img data-lazy-src="/preview/site-abc/img/f.png">' +
        '<picture><img srcset="data:image/png;base64,AA/BB 1x, https://cdn.example.com/x.png 2x, //cdn.example.com/bg.png 3x"></picture>' +
        '<img src="/preview/site-abc/logo.png" data-original="/preview/site-abc/img/g.png">',
    );
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

  it("rewrites CSS @import and url() root references and preserves external/special URLs", () => {
    const css = `@font-face { src: url("/fonts/LeagueSpartan-VariableFont_wght.ttf"); }
@import "/styles/base.css";
@import url("/styles/theme.css");
.bg { background: url(/img/a.png), url("https://cdn.example.com/x.png"), url(data:image/png;base64,AA/BB), url(blob:https://app.example.com/abc), url(//cdn.example.com/bg.png); }
.link { background: url(/preview/site-abc/img/keep.png); }`;
    expect(rewritePreviewCssReferences(css, "site-abc")).toBe(
      `@font-face { src: url("/preview/site-abc/fonts/LeagueSpartan-VariableFont_wght.ttf"); }
@import "/preview/site-abc/styles/base.css";
@import url("/preview/site-abc/styles/theme.css");
.bg { background: url(/preview/site-abc/img/a.png), url("https://cdn.example.com/x.png"), url(data:image/png;base64,AA/BB), url(blob:https://app.example.com/abc), url(//cdn.example.com/bg.png); }
.link { background: url(/preview/site-abc/img/keep.png); }`,
    );
  });

  it("rewrites root-relative url()/@import inside a Vite __vite__css payload without touching other strings", async () => {
    const slug = "site-abc";
    const source = `const __vite__id = "/src/index.scss";
const __vite__css = "@font-face{font-family: \\"League Spartan\\";src:url(\\"/fonts/League_Spartan/LeagueSpartan-VariableFont_wght.ttf\\")}@import \\"/styles/other.css\\";.a{background:url('/img/x.png') url(data:image/png;base64,AA/BB) url(//cdn.example.com/bg.png) url('/preview/site-abc/img/keep.png')}";
const plain = "/not-a-css-payload";
const msg = "leave /fonts/x alone";`;
    const rewritten = rewritePreviewModuleReferences(source, slug);

    expect(rewritten).toContain(
      'src:url(\\"/preview/site-abc/fonts/League_Spartan/LeagueSpartan-VariableFont_wght.ttf\\")',
    );
    expect(rewritten).toContain('@import \\"/preview/site-abc/styles/other.css\\"');
    expect(rewritten).toContain("url('/preview/site-abc/img/x.png')");
    expect(rewritten).toContain("url('/preview/site-abc/img/keep.png')");
    // External/special URLs inside the payload stay untouched.
    expect(rewritten).toContain("url(data:image/png;base64,AA/BB)");
    expect(rewritten).toContain("url(//cdn.example.com/bg.png)");
    // Ordinary strings must survive byte-for-byte.
    expect(rewritten).toContain('const __vite__id = "/src/index.scss";');
    expect(rewritten).toContain('const plain = "/not-a-css-payload";');
    expect(rewritten).toContain('const msg = "leave /fonts/x alone";');

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

  it("rewrites Vite asset-module default-export URLs for PNG/SVG/font/CSS assets", () => {
    const slug = "site-abc";
    const prefix = "/preview/site-abc";
    const cases: Array<[string, string]> = [
      // Rewritten asset modules (the real Vite `export default "…"` form).
      ['export default "/src/assets/bg-login.png"', `export default "${prefix}/src/assets/bg-login.png"`],
      ['export default "/src/assets/icons/check.svg"', `export default "${prefix}/src/assets/icons/check.svg"`],
      ['export default "/fonts/LeagueSpartan-VariableFont_wght.ttf"', `export default "${prefix}/fonts/LeagueSpartan-VariableFont_wght.ttf"`],
      ['export default "/src/assets/theme.css"', `export default "${prefix}/src/assets/theme.css"`],
      // Preserved verbatim — API strings, external/data/protocol-relative, already-prefixed.
      ['export default "/api/health"', 'export default "/api/health"'],
      ['export default "https://cdn.example.com/x.png"', 'export default "https://cdn.example.com/x.png"'],
      ['export default "data:image/png;base64,AA/BB"', 'export default "data:image/png;base64,AA/BB"'],
      ['export default "//cdn.example.com/bg.png"', 'export default "//cdn.example.com/bg.png"'],
      ['export default "/preview/site-abc/src/assets/logo.png"', 'export default "/preview/site-abc/src/assets/logo.png"'],
    ];
    for (const [input, expected] of cases) {
      expect(rewritePreviewModuleReferences(input, slug)).toBe(expected);
    }
  });

  it("rewrites a real Vite asset module (with sourcemap comment) and keeps it valid JavaScript", async () => {
    const slug = "site-abc";
    const source = `export default "/src/assets/bg-login.png"
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImJnLWxvZ2luLnBuZz9pbXBvcnQiXSwic291cmNlc0NvbnRlbnQiOlsiZXhwb3J0IGRlZmF1bHQgXCIvc3JjL2Fzc2V0cy9iZy1sb2dpbi5wbmdcIiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzQ29udGVudCI6W119`;
    const rewritten = rewritePreviewModuleReferences(source, slug);

    expect(rewritten).toContain('export default "/preview/site-abc/src/assets/bg-login.png"');
    // The sourcemap comment must survive untouched (it embeds the asset URL in base64).
    expect(rewritten).toContain("//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjoz");

    const { createSourceFile, ScriptTarget, ScriptKind } = await import("typescript");
    const diagnostics = createSourceFile(
      "asset.js",
      rewritten,
      ScriptTarget.Latest,
      false,
      ScriptKind.JS,
    ).parseDiagnostics;
    expect(diagnostics).toEqual([]);
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

  it("proxies binary assets byte-for-byte and keeps their content type", async () => {
    const fontBytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x80, 0x40, 0x03, 0x01, 0x00]);
    upstream = createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "font/woff2");
      res.end(fontBytes);
    });
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("upstream did not bind");

    const preview = {
      lease: { status: "active", slug: "site-abc", expiresAt: new Date(Date.now() + 60_000) },
      runtimeService: { provider: "local_process", port: address.port, status: "running" },
    } as PreviewLeaseWithRuntimeService;
    const app = express();
    app.use(async (req, res, next) => {
      const target = parsePreviewRequestTarget(req.originalUrl);
      if (!target) return next();
      await proxyPreviewHttp(req, res, preview, target);
    });

    const response = await request(app)
      .get("/preview/site-abc/fonts/LeagueSpartan-VariableFont_wght.ttf")
      .buffer(true);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("font/woff2");
    expect(Buffer.isBuffer(response.body)).toBe(true);
    expect(response.body).toEqual(fontBytes);
  });
});
