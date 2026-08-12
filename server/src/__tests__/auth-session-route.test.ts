import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";

function createSelectChain(rows: unknown[]) {
  return {
    from() {
      return {
        where() {
          return Promise.resolve(rows);
        },
      };
    },
  };
}

function createDb() {
  return {
    select: vi
      .fn()
      .mockImplementationOnce(() => createSelectChain([]))
      .mockImplementationOnce(() => createSelectChain([])),
  } as any;
}

describe("actorMiddleware authenticated session profile", () => {
  const originalCloudTenantToken = process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;

  afterEach(() => {
    if (originalCloudTenantToken === undefined) delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    else process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = originalCloudTenantToken;
  });

  it("preserves the signed-in user name and email on the board actor", async () => {
    const app = express();
    app.use(
      actorMiddleware(createDb(), {
        deploymentMode: "authenticated",
        resolveSession: async () => ({
          session: { id: "session-1", userId: "user-1" },
          user: {
            id: "user-1",
            name: "User One",
            email: "user@example.com",
          },
        }),
      }),
    );
    app.get("/actor", (req, res) => {
      res.json(req.actor);
    });

    const res = await request(app).get("/actor");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: "user-1",
      userName: "User One",
      userEmail: "user@example.com",
      source: "session",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: false,
    });
  });

  it("trusts Cloud tenant identity headers and seeds board access", async () => {
    process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "tenant-token";
    const inserts: Array<{ values: Record<string, unknown> }> = [];
    const db = {
      insert: vi.fn(() => {
        const chain = {
          values(values: Record<string, unknown>) {
            inserts.push({ values });
            return chain;
          },
          onConflictDoUpdate() {
            return chain;
          },
          onConflictDoNothing() {
            return chain;
          },
          returning() {
            return Promise.resolve([{
              companyId: inserts.at(-1)?.values.companyId,
              membershipRole: inserts.at(-1)?.values.membershipRole,
              status: inserts.at(-1)?.values.status,
            }]);
          },
        };
        return chain;
      }),
      select: vi.fn(),
    } as any;
    const app = express();
    app.use(
      actorMiddleware(db, {
        deploymentMode: "authenticated",
        resolveSession: async () => null,
      }),
    );
    app.get("/actor", (req, res) => {
      res.json(req.actor);
    });

    const res = await request(app)
      .get("/actor")
      .set("x-paperclip-cloud-tenant-token", "tenant-token")
      .set("x-paperclip-cloud-user-id", "global-user-1")
      .set("x-paperclip-cloud-user-email", "owner@example.com")
      .set("x-paperclip-cloud-user-name", "Stack Owner")
      .set("x-paperclip-cloud-stack-id", "stack-alpha")
      .set("x-paperclip-cloud-paperclip-company-id", "paperclip-stack-alpha")
      .set("x-paperclip-cloud-stack-role", "owner");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: "global-user-1",
      userName: "Stack Owner",
      userEmail: "owner@example.com",
      source: "cloud_tenant",
      isInstanceAdmin: true,
      memberships: [expect.objectContaining({ membershipRole: "owner", status: "active" })],
    });
    expect(res.body.companyIds[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(inserts).toHaveLength(4);
    expect(inserts[0]?.values).toMatchObject({
      id: "global-user-1",
      email: "owner@example.com",
      emailVerified: true,
    });
  });

  it("falls back to the browser session on preview requests when Authorization carries a foreign JWT", async () => {
    // The previewed app puts its own JWT in the Authorization header on every
    // call. That token is not a Paperclip credential, but the board user's
    // session cookie should still authenticate preview requests.
    const db = {
      select: vi.fn(() => createSelectChain([])),
    } as any;
    const app = express();
    app.use(
      actorMiddleware(db, {
        deploymentMode: "authenticated",
        resolveSession: async () => ({
          session: { id: "session-1", userId: "user-1" },
          user: {
            id: "user-1",
            name: "Board User",
            email: "board@example.com",
          },
        }),
      }),
    );
    app.get("/preview/site-abc/nutrition-agent-api/auth/whoami", (req, res) => {
      res.json(req.actor);
    });

    const res = await request(app)
      .get("/preview/site-abc/nutrition-agent-api/auth/whoami")
      .set("Authorization", "Bearer eyJhbGciOiJIUzI1NiJ9.not-a-paperclip-token.zzz")
      .set("Cookie", "paperclip-default.session_token=board-session");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: "user-1",
      userName: "Board User",
      source: "session",
    });
  });
});
