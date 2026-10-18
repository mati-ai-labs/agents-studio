import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/instance-previews.js", () => ({
  instancePreviewsService: () => ({}),
}));

const creds = {
  domain: "preview.example.com",
  zone: "example.com",
  provider: "hostinger" as const,
  token: "hostinger-token",
};

async function createApp(
  fetchImpl: typeof fetch,
  overrides: { readCredentials?: () => Promise<typeof creds | null>; waitForTxt?: ReturnType<typeof vi.fn> } = {},
) {
  const [{ previewDnsRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/preview-dns.js"),
    import("../middleware/index.js"),
  ]);
  const waitForTxt = overrides.waitForTxt ?? vi.fn().mockResolvedValue(true);
  const recordChallenge = vi.fn().mockResolvedValue(undefined);
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    previewDnsRoutes({} as never, {
      readHookSecret: () => "hook-secret",
      readCredentials: overrides.readCredentials ?? (async () => creds),
      recordChallenge,
      fetchImpl,
      waitForTxt,
    }),
  );
  app.use(errorHandler);
  return { app, waitForTxt, recordChallenge };
}

function okFetch() {
  return vi.fn().mockResolvedValue(new Response("{}", { status: 200 })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("preview dns routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("appends the challenge TXT record with the instance DNS token and waits for it", async () => {
    const fetchImpl = okFetch();
    const { app, waitForTxt, recordChallenge } = await createApp(fetchImpl);

    const res = await request(app)
      .post("/api/internal/preview-dns/present")
      .set("X-Preview-DNS-Secret", "hook-secret")
      .send({ domain: "preview.example.com", validation: "abc123" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, record: "_acme-challenge.preview.example.com" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://developers.hostinger.com/api/dns/v1/zones/example.com");
    expect(init.method).toBe("PUT");
    expect(init.headers.Authorization).toBe("Bearer hostinger-token");
    expect(JSON.parse(init.body)).toEqual({
      overwrite: false,
      zone: [{ name: "_acme-challenge.preview", type: "TXT", ttl: 60, records: [{ content: "abc123" }] }],
    });
    expect(waitForTxt).toHaveBeenCalledWith("example.com", "_acme-challenge.preview.example.com", "abc123");
    expect(recordChallenge).toHaveBeenCalledWith(expect.objectContaining({ ok: true, error: null }));
  });

  it("records a failed challenge when Hostinger rejects the token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"message":"Unauthenticated."}', { status: 401 })) as unknown as typeof fetch;
    const { app, recordChallenge } = await createApp(fetchImpl);

    const res = await request(app)
      .post("/api/internal/preview-dns/present")
      .set("X-Preview-DNS-Secret", "hook-secret")
      .send({ domain: "preview.example.com", validation: "abc123" });

    expect(res.status).toBe(500);
    expect(recordChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: expect.stringContaining("HTTP 401") }),
    );
  });

  it("deletes only the challenge TXT record on cleanup", async () => {
    const fetchImpl = okFetch();
    const { app } = await createApp(fetchImpl);

    const res = await request(app)
      .post("/api/internal/preview-dns/cleanup")
      .set("X-Preview-DNS-Secret", "hook-secret")
      .send({ domain: "*.preview.example.com" });

    expect(res.status).toBe(200);
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body)).toEqual({ filters: [{ name: "_acme-challenge.preview", type: "TXT" }] });
  });

  it("rejects a wrong secret, a proxied request, and other domains", async () => {
    const fetchImpl = okFetch();
    const { app } = await createApp(fetchImpl);

    const wrongSecret = await request(app)
      .post("/api/internal/preview-dns/present")
      .set("X-Preview-DNS-Secret", "nope")
      .send({ domain: "preview.example.com", validation: "abc" });
    expect(wrongSecret.status).toBe(403);

    const proxied = await request(app)
      .post("/api/internal/preview-dns/present")
      .set("X-Preview-DNS-Secret", "hook-secret")
      .set("X-Real-IP", "203.0.113.9")
      .send({ domain: "preview.example.com", validation: "abc" });
    expect(proxied.status).toBe(403);

    const otherDomain = await request(app)
      .post("/api/internal/preview-dns/present")
      .set("X-Preview-DNS-Secret", "hook-secret")
      .send({ domain: "agentstudio.example.com", validation: "abc" });
    expect(otherDomain.status).toBe(403);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails clearly when previews DNS is not configured", async () => {
    const fetchImpl = okFetch();
    const { app } = await createApp(fetchImpl, { readCredentials: async () => null });

    const res = await request(app)
      .post("/api/internal/preview-dns/present")
      .set("X-Preview-DNS-Secret", "hook-secret")
      .send({ domain: "preview.example.com", validation: "abc" });

    expect(res.status).toBe(422);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("runPreviewDnsTest", () => {
  it("writes a test record, waits for it, and always cleans it up", async () => {
    const { runPreviewDnsTest } = await import("../routes/preview-dns.js");
    const fetchImpl = okFetch();
    const waitForTxt = vi.fn().mockResolvedValue(true);

    const result = await runPreviewDnsTest(creds, { fetchImpl, waitForTxt });

    expect(result).toEqual({ ok: true, record: "_agentstudio-dns-test.preview.example.com", error: null });
    expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual(["PUT", "DELETE"]);
  });

  it("reports the Hostinger error and still attempts cleanup", async () => {
    const { runPreviewDnsTest } = await import("../routes/preview-dns.js");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"message":"Unauthenticated."}', { status: 401 }))
      .mockResolvedValue(new Response("{}", { status: 200 })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

    const result = await runPreviewDnsTest(creds, { fetchImpl, waitForTxt: vi.fn() });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("HTTP 401");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
