import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({
  getCredentialsAsync: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("../services/connector-registry.js", () => ({
  connectorRegistryService: () => registry,
}));

import { resolveGoogleWorkspaceMcpAccessToken } from "../services/google-workspace-mcp-auth.js";

const ORIGINAL_GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const ORIGINAL_GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const ORIGINAL_FETCH = globalThis.fetch;

describe("resolveGoogleWorkspaceMcpAccessToken", () => {
  beforeEach(() => {
    registry.getCredentialsAsync.mockReset();
    registry.upsert.mockReset();
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    process.env.GOOGLE_CLIENT_ID = "google-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "google-client-secret";
  });

  afterEach(() => {
    if (ORIGINAL_GOOGLE_CLIENT_ID === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = ORIGINAL_GOOGLE_CLIENT_ID;

    if (ORIGINAL_GOOGLE_CLIENT_SECRET === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = ORIGINAL_GOOGLE_CLIENT_SECRET;

    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("returns the stored access token when it is not expired", async () => {
    const nowMs = Date.now();
    registry.getCredentialsAsync.mockResolvedValue({
      accessToken: "stored-token",
      refreshToken: "refresh-token",
      expiry: nowMs + 10 * 60 * 1000,
    });

    const result = await resolveGoogleWorkspaceMcpAccessToken({
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

  it("refreshes and persists a new access token when the stored token is expired", async () => {
    const nowMs = Date.now();
    registry.getCredentialsAsync.mockResolvedValue({
      accessToken: "expired-token",
      refreshToken: "refresh-token",
      expiry: nowMs - 1,
    });
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "fresh-token",
        expires_in: 3600,
      }),
    });

    const result = await resolveGoogleWorkspaceMcpAccessToken({
      db: {} as any,
      companyId: "company-1",
      nowMs,
    });

    expect(result.accessToken).toBe("fresh-token");
    expect(result.refreshed).toBe(true);
    expect(result.expiresAtMs).toBe(nowMs + 3_600_000);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(registry.upsert).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-1",
      type: "google_workspace",
      credentials: expect.objectContaining({
        accessToken: "fresh-token",
        refreshToken: "refresh-token",
        expiry: nowMs + 3_600_000,
      }),
    }));
  });
});
