import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSvc = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  getDnsCredentials: vi.fn(),
  recordEvent: vi.fn(),
  listCompanies: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/instance-previews.js", () => ({
  instancePreviewsService: () => mockSvc,
  inspectPreviewCertificate: vi.fn(),
}));
vi.mock("../services/index.js", () => ({
  logActivity: mockLogActivity,
}));

const adminActor = { type: "board", userId: "admin-1", source: "session", isInstanceAdmin: true, companyIds: [] };
const memberActor = {
  type: "board",
  userId: "member-1",
  source: "session",
  isInstanceAdmin: false,
  companyIds: ["11111111-1111-4111-8111-111111111111"],
  memberships: [{ companyId: "11111111-1111-4111-8111-111111111111", membershipRole: "member", status: "active" }],
};

const baseSettings = {
  domain: "preview.example.com",
  dnsProvider: "hostinger",
  dnsZone: "example.com",
  dnsTokenConfigured: true,
  enabledCompanyIds: ["11111111-1111-4111-8111-111111111111"],
  lastDnsTest: null,
  lastChallenge: null,
};

async function createApp(actor: Record<string, unknown>) {
  const [{ instancePreviewsRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/instance-previews.js"),
    import("../middleware/index.js"),
  ]);
  const runDnsTest = vi.fn().mockResolvedValue({ ok: true, record: "_agentstudio-dns-test.preview.example.com", error: null });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(
    "/api",
    instancePreviewsRoutes({} as never, {
      inspectCertificate: async () => ({ status: "valid", expiresAt: "2027-01-01T00:00:00.000Z", issuer: "Let's Encrypt", error: null }),
      runDnsTest,
    }),
  );
  app.use(errorHandler);
  return { app, runDnsTest };
}

describe("instance previews routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSvc.get.mockResolvedValue(baseSettings);
    mockSvc.listCompanies.mockResolvedValue([
      { id: "11111111-1111-4111-8111-111111111111", name: "Acme" },
      { id: "22222222-2222-4222-8222-222222222222", name: "Beta" },
    ]);
  });

  it("returns settings, certificate status and per-company toggles without the token", async () => {
    const { app } = await createApp(adminActor);
    const res = await request(app).get("/api/instance/settings/previews");

    expect(res.status).toBe(200);
    expect(res.body.certificate.status).toBe("valid");
    expect(res.body.companies).toEqual([
      { id: "11111111-1111-4111-8111-111111111111", name: "Acme", previewsEnabled: true },
      { id: "22222222-2222-4222-8222-222222222222", name: "Beta", previewsEnabled: false },
    ]);
    expect(JSON.stringify(res.body)).not.toContain("dnsTokenEncrypted");
  });

  it("requires instance admin to read or change settings", async () => {
    const { app } = await createApp(memberActor);
    expect((await request(app).get("/api/instance/settings/previews")).status).toBe(403);
    expect((await request(app).patch("/api/instance/settings/previews").send({ domain: "x.example.com" })).status).toBe(403);
    expect(mockSvc.update).not.toHaveBeenCalled();
  });

  it("logs an activity entry for each company toggled on or off", async () => {
    mockSvc.update.mockResolvedValue({ ...baseSettings, enabledCompanyIds: ["22222222-2222-4222-8222-222222222222"] });
    const { app } = await createApp(adminActor);

    const res = await request(app)
      .patch("/api/instance/settings/previews")
      .send({ enabledCompanyIds: ["22222222-2222-4222-8222-222222222222"] });

    expect(res.status).toBe(200);
    expect(mockSvc.update).toHaveBeenCalledWith({ enabledCompanyIds: ["22222222-2222-4222-8222-222222222222"] });
    const actions = mockLogActivity.mock.calls.map(([, input]) => [input.companyId, input.action]).sort();
    expect(actions).toEqual([
      ["11111111-1111-4111-8111-111111111111", "instance.previews.company_disabled"],
      ["22222222-2222-4222-8222-222222222222", "instance.previews.company_enabled"],
    ]);
  });

  it("rejects unknown fields", async () => {
    const { app } = await createApp(adminActor);
    const res = await request(app).patch("/api/instance/settings/previews").send({ dnsTokenEncrypted: "x" });
    expect(res.status).toBe(400);
  });

  it("runs the DNS test with stored credentials and records the result", async () => {
    mockSvc.getDnsCredentials.mockResolvedValue({ domain: "preview.example.com", zone: "example.com", provider: "hostinger", token: "t" });
    const { app, runDnsTest } = await createApp(adminActor);

    const res = await request(app).post("/api/instance/settings/previews/test-dns");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(runDnsTest).toHaveBeenCalled();
    expect(mockSvc.recordEvent).toHaveBeenCalledWith("lastDnsTest", expect.objectContaining({ ok: true }));
  });

  it("tells a company member whether previews are enabled for their company", async () => {
    const { app } = await createApp(memberActor);
    const res = await request(app).get("/api/companies/11111111-1111-4111-8111-111111111111/previews");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, domain: "preview.example.com" });
  });
});
