import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({
  getCredentialsAsync: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("../services/connector-registry.js", () => ({
  connectorRegistryService: () => registry,
}));

import { resolveMetaAdsMcpAccessToken } from "../services/meta-ads-mcp-auth.js";

const ORIGINAL_META_ADS_APP_ID = process.env.META_ADS_APP_ID;
const ORIGINAL_META_ADS_APP_SECRET = process.env.META_ADS_APP_SECRET;
const ORIGINAL_FETCH = globalThis.fetch;

describe("resolveMetaAdsMcpAccessToken", () => {
  beforeEach(() => {
    registry.getCredentialsAsync.mockReset();
    registry.upsert.mockReset();
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    process.env.META_ADS_APP_ID = "meta-app-id";
    process.env.META_ADS_APP_SECRET = "meta-app-secret";
  });

  afterEach(() => {
    if (ORIGINAL_META_ADS_APP_ID === undefined) delete process.env.META_ADS_APP_ID;
    else process.env.META_ADS_APP_ID = ORIGINAL_META_ADS_APP_ID;

    if (ORIGINAL_META_ADS_APP_SECRET === undefined) delete process.env.META_ADS_APP_SECRET;
    else process.env.META_ADS_APP_SECRET = ORIGINAL_META_ADS_APP_SECRET;

    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("returns the stored access token when it is not expired", async () => {
    const nowMs = Date.now();
    registry.getCredentialsAsync.mockResolvedValue({
      accessToken: "stored-token",
      refreshToken: "stored-token",
      expiry: nowMs + 10 * 60 * 1000,
    });

    const result = await resolveMetaAdsMcpAccessToken({
      db: {} as any,
      companyId: "company-1",
      nowMs,
    });

    expect(result).toEqual({
      accessToken: "stored-token",
      refreshed: false,
      expiresAtMs: nowMs + 10 * 60 * 1000,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(registry.upsert).not.toHaveBeenCalled();
  });

  it("returns null when no credentials are stored for the connector", async () => {
    registry.getCredentialsAsync.mockResolvedValue(null);

    const result = await resolveMetaAdsMcpAccessToken({
      db: {} as any,
      companyId: "company-1",
      nowMs: Date.now(),
    });

    expect(result.accessToken).toBeNull();
    expect(result.refreshed).toBe(false);
    expect(result.reason).toBe("missing_credentials");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(registry.upsert).not.toHaveBeenCalled();
  });

  it("refreshes via fb_exchange_token and persists a new access token when the stored token is expired", async () => {
    const nowMs = Date.now();
    registry.getCredentialsAsync.mockResolvedValue({
      accessToken: "expired-token",
      refreshToken: "expired-token",
      expiry: nowMs - 1,
    });
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "fresh-token",
        expires_in: 3600,
      }),
    });

    const result = await resolveMetaAdsMcpAccessToken({
      db: {} as any,
      companyId: "company-1",
      nowMs,
    });

    expect(result.accessToken).toBe("fresh-token");
    expect(result.refreshed).toBe(true);
    expect(result.expiresAtMs).toBe(nowMs + 3_600_000);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const fetchUrl = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(fetchUrl).toContain("grant_type=fb_exchange_token");
    expect(fetchUrl).toContain("client_id=meta-app-id");
    expect(fetchUrl).toContain("client_secret=meta-app-secret");
    expect(fetchUrl).toContain("fb_exchange_token=expired-token");
    expect(registry.upsert).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-1",
      type: "meta_ads",
      credentials: expect.objectContaining({
        accessToken: "fresh-token",
        refreshToken: "fresh-token",
        expiry: nowMs + 3_600_000,
      }),
    }));
  });

  it("returns null and skips refresh when META_ADS_APP_ID / META_ADS_APP_SECRET are missing and the token is expired", async () => {
    delete process.env.META_ADS_APP_ID;
    delete process.env.META_ADS_APP_SECRET;

    const nowMs = Date.now();
    registry.getCredentialsAsync.mockResolvedValue({
      accessToken: "expired-token",
      refreshToken: "expired-token",
      expiry: nowMs - 1,
    });

    const result = await resolveMetaAdsMcpAccessToken({
      db: {} as any,
      companyId: "company-1",
      nowMs,
    });

    expect(result.accessToken).toBeNull();
    expect(result.refreshed).toBe(false);
    expect(result.reason).toBe("missing_meta_ads_oauth_client_config");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(registry.upsert).not.toHaveBeenCalled();
  });

  it("returns the stored token and skips refresh when env vars are missing but the token is not yet expired", async () => {
    delete process.env.META_ADS_APP_ID;
    delete process.env.META_ADS_APP_SECRET;

    const nowMs = Date.now();
    registry.getCredentialsAsync.mockResolvedValue({
      accessToken: "stored-token",
      refreshToken: "stored-token",
      expiry: nowMs + 30 * 60 * 1000,
    });

    const result = await resolveMetaAdsMcpAccessToken({
      db: {} as any,
      companyId: "company-1",
      nowMs,
    });

    expect(result.accessToken).toBe("stored-token");
    expect(result.refreshed).toBe(false);
    expect(result.reason).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(registry.upsert).not.toHaveBeenCalled();
  });

  it("returns null when the Meta refresh response does not contain an access_token", async () => {
    const nowMs = Date.now();
    registry.getCredentialsAsync.mockResolvedValue({
      accessToken: "expired-token",
      refreshToken: "expired-token",
      expiry: nowMs - 1,
    });
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const result = await resolveMetaAdsMcpAccessToken({
      db: {} as any,
      companyId: "company-1",
      nowMs,
    });

    expect(result.accessToken).toBeNull();
    expect(result.refreshed).toBe(false);
    expect(result.reason).toBe("meta_ads_refresh_missing_access_token");
    expect(registry.upsert).not.toHaveBeenCalled();
  });
});
