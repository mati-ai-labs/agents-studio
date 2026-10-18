import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  instanceSettings,
  previewLeases,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import { instancePreviewsService } from "../services/instance-previews.js";
import { previewLeaseService } from "../services/previews.js";
import { setPreviewAuthKeyForTests } from "../services/preview-auth.js";
import { setCachedPreviewDomain } from "../services/preview-hosts.js";
import { previewAuthRoutes, previewHostMiddleware } from "../routes/previews.js";
import { setupPreviewWebSocketServer } from "../realtime/preview-ws.js";

const { WebSocket, WebSocketServer } = createRequire(import.meta.url)("ws") as any;
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

const DOMAIN = "preview.example.com";

describeEmbeddedPostgres("preview subdomains", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let upstream: Server;
  let upstreamPort = 0;
  let seen: { url?: string; auth?: string; cookie?: string; prefix?: string } = {};
  let companyId = "";
  let slug = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-preview-host-");
    db = createDb(tempDb.connectionString);
    upstream = createServer((req, res) => {
      seen = {
        url: req.url,
        auth: req.headers.authorization,
        cookie: req.headers.cookie,
        prefix: req.headers["x-forwarded-prefix"] as string | undefined,
      };
      if (req.url === "/go-login") {
        res.writeHead(302, { location: `http://127.0.0.1:${upstreamPort}/login?x=1` });
        res.end();
        return;
      }
      res.setHeader("content-type", "text/html");
      res.setHeader("set-cookie", "app=1; Path=/; Domain=127.0.0.1");
      res.end('<script src="/assets/app.js"></script>');
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    upstreamPort = (upstream.address() as { port: number }).port;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await tempDb?.cleanup();
    setPreviewAuthKeyForTests(null);
    setCachedPreviewDomain(null);
  });

  beforeEach(async () => {
    setPreviewAuthKeyForTests(randomBytes(32));
    process.env.PAPERCLIP_PUBLIC_URL = "https://studio.example.com";
    companyId = randomUUID();
    const runtimeServiceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Lch", issuePrefix: "LCH" });
    await db.insert(workspaceRuntimeServices).values({
      id: runtimeServiceId,
      companyId,
      scopeType: "project_workspace",
      scopeId: "ws-1",
      serviceName: "web",
      status: "running",
      lifecycle: "shared",
      command: "pnpm dev",
      cwd: "/tmp/x",
      port: upstreamPort,
      provider: "local_process",
    });
    await instancePreviewsService(db).update({ domain: DOMAIN, dnsZone: "example.com", enabledCompanyIds: [companyId] });
    setCachedPreviewDomain(DOMAIN);
    const lease = await previewLeaseService(db).createForRuntimeService({ companyId, runtimeServiceId });
    slug = lease.slug;
    expect(lease.url).toBe(`https://${slug}.${DOMAIN}/`);
    expect(slug).toMatch(/^lch-web-/);
  });

  afterEach(async () => {
    await db.delete(previewLeases);
    await db.delete(workspaceRuntimeServices);
    await db.delete(companies);
    await db.delete(instanceSettings);
    delete process.env.PAPERCLIP_PUBLIC_URL;
  });

  function app(actor: Record<string, unknown>) {
    const a = express();
    a.use(express.json());
    a.use(previewHostMiddleware(db));
    a.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    a.use("/api", previewAuthRoutes(db));
    return a;
  }

  const member = () => ({ type: "board", userId: "u1", source: "session", companyIds: [companyId] });

  async function signIn() {
    const start = await request(app(member()))
      .get(`/api/preview-auth/start?slug=${slug}&path=${encodeURIComponent("/dash?a=1")}`)
      .set("host", "studio.example.com");
    expect(start.status).toBe(302);
    const handoff = new URL(start.headers.location);
    expect(handoff.host).toBe(`${slug}.${DOMAIN}`);
    const done = await request(app({ type: "none" }))
      .get(`${handoff.pathname}${handoff.search}`)
      .set("host", `${slug}.${DOMAIN}`)
      .set("x-forwarded-proto", "https");
    expect(done.status).toBe(302);
    expect(done.headers.location).toBe("/dash?a=1");
    const cookie = String(done.headers["set-cookie"]).split(";")[0]!;
    expect(cookie).toMatch(/^agentstudio_preview=/);
    return { cookie, handoffPath: `${handoff.pathname}${handoff.search}` };
  }

  it("sends visitors without a session to Agent Studio sign-in", async () => {
    const res = await request(app({ type: "none" }))
      .get("/dash")
      .set("host", `${slug}.${DOMAIN}`)
      .set("accept", "text/html");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      `https://studio.example.com/api/preview-auth/start?slug=${slug}&path=${encodeURIComponent("/dash")}`,
    );

    const api = await request(app({ type: "none" })).post("/api/data").set("host", `${slug}.${DOMAIN}`).send({});
    expect(api.status).toBe(401);
  });

  it("sends signed-out users to login, then resumes", async () => {
    const res = await request(app({ type: "none" })).get(`/api/preview-auth/start?slug=${slug}&path=/`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/login?next=${encodeURIComponent(`/preview-auth?slug=${slug}&path=%2F`)}`);
  });

  it("hides previews from users outside the company", async () => {
    const outsider = { type: "board", userId: "u2", source: "session", companyIds: [randomUUID()] };
    const res = await request(app(outsider)).get(`/api/preview-auth/start?slug=${slug}`);
    expect(res.status).toBe(404);
  });

  it("proxies the app at the root once signed in, with its own credentials", async () => {
    const { cookie, handoffPath } = await signIn();
    const res = await request(app({ type: "none" }))
      .get("/dash?a=1")
      .set("host", `${slug}.${DOMAIN}`)
      .set("authorization", "Bearer app-jwt")
      .set("cookie", `${cookie}; app=1`);
    expect(res.status).toBe(200);
    expect(res.text).toBe('<script src="/assets/app.js"></script>');
    expect(seen).toMatchObject({ url: "/dash?a=1", auth: "Bearer app-jwt", cookie: "app=1", prefix: undefined });
    expect(String(res.headers["set-cookie"])).toBe("app=1; Path=/");

    const redirect = await request(app({ type: "none" }))
      .get("/go-login")
      .set("host", `${slug}.${DOMAIN}`)
      .set("cookie", cookie);
    expect(redirect.headers.location).toBe("/login?x=1");

    // The handoff token is single use.
    const replay = await request(app({ type: "none" })).get(handoffPath).set("host", `${slug}.${DOMAIN}`);
    expect(replay.status).toBe(403);

    // A session for one preview doesn't open another.
    const other = await request(app({ type: "none" }))
      .get("/")
      .set("host", `lch-web-ffffffffffffffffff.${DOMAIN}`)
      .set("cookie", cookie);
    expect(other.status).toBe(404);
  });

  it("blocks previews when the company is switched off", async () => {
    const { cookie } = await signIn();
    await instancePreviewsService(db).update({ enabledCompanyIds: [] });
    const res = await request(app({ type: "none" })).get("/").set("host", `${slug}.${DOMAIN}`).set("cookie", cookie);
    expect(res.status).toBe(403);
  });

  it("leaves other hosts to the rest of the app", async () => {
    const res = await request(app({ type: "none" })).get("/").set("host", "studio.example.com");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("Preview");
  });

  it("bridges WebSockets on the preview host for signed-in users only", async () => {
    const { cookie } = await signIn();
    // Upstream app: echo server on the runtime service's port.
    const echoServer = createServer();
    const echo = new WebSocketServer({ server: echoServer });
    echo.on("connection", (socket: any, req: any) => socket.send(`hello ${req.url} cookie=${req.headers.cookie ?? ""}`));
    await new Promise<void>((resolve) => echoServer.listen(0, "127.0.0.1", resolve));
    await db.update(workspaceRuntimeServices).set({ port: (echoServer.address() as { port: number }).port });

    const front = createServer(app({ type: "none" }));
    setupPreviewWebSocketServer(front, db, { deploymentMode: "authenticated" } as any);
    await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
    const url = `ws://127.0.0.1:${(front.address() as { port: number }).port}/__vite_hmr?token=t`;

    try {
      const message = await new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(url, { headers: { host: `${slug}.${DOMAIN}`, cookie: `${cookie}; app=1` } });
        ws.on("message", (data: Buffer) => { resolve(data.toString()); ws.close(); });
        ws.on("error", reject);
      });
      expect(message).toBe("hello /__vite_hmr?token=t cookie=app=1");

      const status = await new Promise<number>((resolve) => {
        const ws = new WebSocket(url, { headers: { host: `${slug}.${DOMAIN}` } });
        ws.on("unexpected-response", (_req: unknown, res: { statusCode: number }) => resolve(res.statusCode));
        ws.on("open", () => resolve(101));
        ws.on("error", () => undefined);
      });
      expect(status).toBe(403);
    } finally {
      await new Promise<void>((resolve) => front.close(() => resolve()));
      echo.close();
      await new Promise<void>((resolve) => echoServer.close(() => resolve()));
    }
  });
});
