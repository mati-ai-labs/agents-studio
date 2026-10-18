import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRegistry = vi.hoisted(() => ({
  getCredentialsForAgentAsync: vi.fn(),
}));

vi.mock("../services/connector-registry.js", () => ({
  connectorRegistryService: () => mockRegistry,
}));

const config = {
  previewDomain: "preview.example.com",
  zone: "example.com",
  companyId: "company-1",
  hookSecret: "hook-secret",
};

async function createApp(fetchImpl: typeof fetch, waitForTxt = vi.fn().mockResolvedValue(true)) {
  const [{ previewDnsRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/preview-dns.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use("/api", previewDnsRoutes({} as never, { readConfig: () => config, fetchImpl, waitForTxt }));
  app.use(errorHandler);
  return { app, waitForTxt };
}

function okFetch() {
  return vi.fn().mockResolvedValue(new Response("{}", { status: 200 })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("preview dns routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry.getCredentialsForAgentAsync.mockResolvedValue({
      credentials: { accessToken: "hostinger-token" },
      sourceUserId: "user-1",
    });
  });

  it("appends the challenge TXT record with the connector token and waits for it", async () => {
    const fetchImpl = okFetch();
    const { app, waitForTxt } = await createApp(fetchImpl);

    const res = await request(app)
      .post("/api/internal/preview-dns/present")
      .set("X-Preview-DNS-Secret", "hook-secret")
      .send({ domain: "preview.example.com", validation: "abc123" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, record: "_acme-challenge.preview.example.com" });
    expect(mockRegistry.getCredentialsForAgentAsync).toHaveBeenCalledWith("company-1", "hostinger");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://developers.hostinger.com/api/dns/v1/zones/example.com");
    expect(init.method).toBe("PUT");
    expect(init.headers.Authorization).toBe("Bearer hostinger-token");
    expect(JSON.parse(init.body)).toEqual({
      overwrite: false,
      zone: [{ name: "_acme-challenge.preview", type: "TXT", ttl: 60, records: [{ content: "abc123" }] }],
    });
    expect(waitForTxt).toHaveBeenCalledWith("example.com", "_acme-challenge.preview.example.com", "abc123");
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

  it("fails clearly when the Hostinger connector is missing", async () => {
    mockRegistry.getCredentialsForAgentAsync.mockResolvedValue(null);
    const fetchImpl = okFetch();
    const { app } = await createApp(fetchImpl);

    const res = await request(app)
      .post("/api/internal/preview-dns/present")
      .set("X-Preview-DNS-Secret", "hook-secret")
      .send({ domain: "preview.example.com", validation: "abc" });

    expect(res.status).toBe(422);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
