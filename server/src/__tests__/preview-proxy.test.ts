import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import {
  buildPreviewUpstreamHeaders,
  parsePreviewRequestTarget,
  previewPathPrefix,
  proxyPreviewHttp,
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

  it("rewrites root-relative imports inside Vite JavaScript and CSS responses", () => {
    const source = [
      'import "/node_modules/.vite/deps/react.js";',
      'import "/@vite/client";',
      'const stylesheet = "/src/app.scss";',
      'const font = url(/assets/font.woff2);',
      'const external = "https://example.com/app.js";',
    ].join("\n");

    const rewritten = rewritePreviewModuleReferences(source, "site-abc");

    expect(rewritten).toContain('import "/preview/site-abc/node_modules/.vite/deps/react.js";');
    expect(rewritten).toContain('import "/preview/site-abc/@vite/client";');
    expect(rewritten).toContain('const stylesheet = "/preview/site-abc/src/app.scss";');
    expect(rewritten).toContain("url(/preview/site-abc/assets/font.woff2)");
    expect(rewritten).toContain('"https://example.com/app.js"');
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
