/**
 * @fileoverview Smoke test for the new `surge` connector type.
 */
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";

interface FakeRow {
  id: string;
  companyId: string;
  userId: string | null;
  type: string;
  config: Record<string, unknown>;
  status: string;
  credentialsEncrypted: string | null;
  displayName: string | null;
  lastError: string | null;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const fakeRows = new Map<string, FakeRow>();

vi.mock("../services/connector-registry.js", () => {
  function getKey(companyId: string, type: string) {
    return `${companyId}:${type}`;
  }
  function makeRow(companyId: string, type: string): FakeRow {
    return {
      id: `id-${type}-${companyId}`,
      companyId,
      userId: null,
      type,
      config: {},
      status: "disconnected",
      credentialsEncrypted: null,
      displayName: null,
      lastError: null,
      connectedAt: null,
      disconnectedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }
  return {
    connectorRegistryService: () => ({
      listByCompanyForUser: async (companyId: string) => {
        return Array.from(fakeRows.values()).filter((r) => r.companyId === companyId);
      },
      getByType: async (companyId: string, type: string, userId?: string | null) => {
        const row = fakeRows.get(getKey(companyId, type)) ?? null;
        if (!row) return null;
        return { ...row, userId: userId ?? row.userId };
      },
      upsert: async (input: {
        companyId: string;
        type: string;
        userId?: string | null;
        config?: Record<string, unknown>;
        status?: string;
        credentials?: { accessToken: string; refreshToken?: string };
        displayName?: string;
      }) => {
        const key = getKey(input.companyId, input.type);
        const existing = fakeRows.get(key) ?? makeRow(input.companyId, input.type);
        const next: FakeRow = {
          ...existing,
          companyId: input.companyId,
          type: input.type,
          userId: input.userId ?? existing.userId,
          config: input.config ?? existing.config,
          status: input.status ?? existing.status,
          credentialsEncrypted: input.credentials
            ? `STUBENC::${JSON.stringify(input.credentials)}`
            : existing.credentialsEncrypted,
          displayName: input.displayName ?? existing.displayName,
          updatedAt: new Date(),
        };
        fakeRows.set(key, next);
        return next;
      },
      disconnectForUser: async (companyId: string, type: string, _userId: string) => {
        const key = getKey(companyId, type);
        const existing = fakeRows.get(key);
        if (!existing) return null;
        existing.status = "disconnected";
        existing.credentialsEncrypted = null;
        return existing;
      },
      getCredentialsAsync: async (
        companyId: string,
        type: string,
        _opts?: { userId?: string | null },
      ) => {
        const row = fakeRows.get(getKey(companyId, type));
        if (!row?.credentialsEncrypted) return null;
        const enc = row.credentialsEncrypted.replace(/^STUBENC::/, "");
        return JSON.parse(enc) as { accessToken: string; refreshToken?: string };
      },
      getCredentialsForAgentAsync: async (companyId: string, type: string) => {
        const row = fakeRows.get(getKey(companyId, type));
        if (!row?.credentialsEncrypted) return null;
        const enc = row.credentialsEncrypted.replace(/^STUBENC::/, "");
        const credentials = JSON.parse(enc) as { accessToken: string; refreshToken?: string };
        return { credentials, sourceUserId: row.userId };
      },
    }),
  };
});

vi.mock("../lib/encryption.js", () => ({
  encryptValue: (v: string) => `STUBENC::${v}`,
  decryptValue: (v: string) => v.replace(/^STUBENC::/, ""),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock("./authz.js", () => ({
  assertAuthenticated: () => {},
  assertBoard: () => {},
  assertCompanyAccess: () => {},
}));

import { createConnectorsRouter } from "../routes/connectors.js";
import { createLocalAgentJwt, verifyLocalAgentJwt } from "../agent-auth-jwt.js";

const ORIGINAL_SECRET = process.env.PAPERCLIP_AGENT_JWT_SECRET;
process.env.PAPERCLIP_AGENT_JWT_SECRET = "test-jwt-surge-connector-secret-32";
process.env.PAPERCLIP_AGENT_JWT_ISSUER = "paperclip";
process.env.PAPERCLIP_AGENT_JWT_AUDIENCE = "paperclip-api";

interface ActorContext {
  type: "board" | "agent";
  companyId?: string;
  companyIds?: string[];
  agentId?: string;
  runId?: string;
  source?: string;
}

declare module "express-serve-static-core" {
  interface Request {
    actor?: ActorContext;
  }
}

function injectBoardActor(companyId: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.actor = {
      type: "board",
      userId: "test-user-id-1234",
      companyIds: [companyId],
      source: "test",
    };
    next();
  };
}

describe("surge connector wiring", () => {
  let app: express.Express;
  const COMPANY_ID = "11111111-1111-1111-1111-111111111111";
  const AGENT_ID = "22222222-2222-2222-2222-222222222222";

  beforeAll(() => {
    app = express();
    app.use(express.json());
    // Catch-all db stub: any db call returns a fluent query builder that
    // resolves to an empty array, so resolveCompanyId's fallback path works.
    const fakeDb = new Proxy({}, {
      get: () => () => ({
        from: () => ({
          limit: () => Promise.resolve([]),
          where: () => ({ limit: () => Promise.resolve([]) }),
        }),
        where: () => ({ limit: () => Promise.resolve([]) }),
      }),
    }) as never;
    const router = createConnectorsRouter({
      db: fakeDb,
      getBaseUrl: () => "http://localhost",
    });
    // Mount twice: once at /connectors (board API) and once at /agents (agent runtime)
    app.use(injectBoardActor(COMPANY_ID));
    app.use("/connectors", router);
    app.use("/agents", router);

    const jwt = createLocalAgentJwt(AGENT_ID, COMPANY_ID, "claude_local", "run-1");
    expect(jwt).toBeTruthy();
    const claims = verifyLocalAgentJwt(jwt as string);
    expect(claims?.sub).toBe(AGENT_ID);
  });

  afterAll(() => {
    if (ORIGINAL_SECRET === undefined) {
      delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    } else {
      process.env.PAPERCLIP_AGENT_JWT_SECRET = ORIGINAL_SECRET;
    }
  });

  it("configures surge with token + default_domain", async () => {
    const res = await request(app)
      .post(`/connectors/surge/configure`)
      .send({ token: "fake-surge-token-abc123", default_domain: "my-cool-site" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.connector).toMatchObject({
      type: "surge",
      status: "connected",
      displayName: "my-cool-site",
      config: { default_domain: "my-cool-site" },
    });
  });

  it("rejects surge configure without token", async () => {
    const res = await request(app)
      .post(`/connectors/surge/configure`)
      .send({ default_domain: "somewhere" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/surge requires token/);
  });

  it("rejects surge configure with empty token", async () => {
    const res = await request(app)
      .post(`/connectors/surge/configure`)
      .send({ token: "   " });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/surge requires token/);
  });

  it("returns 400 for invalid type on agent credentials endpoint", async () => {
    const res = await request(app).get(`/agents/${AGENT_ID}/connector-credentials/foobar`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid connector type/);
  });

  it("agent endpoint returns surge creds in correct shape", async () => {
    await request(app)
      .post(`/connectors/surge/configure`)
      .send({ token: "agent-test-token", default_domain: "agent-test-site" });

    const token = createLocalAgentJwt(AGENT_ID, COMPANY_ID, "claude_local", "run-1");
    const res = await request(app)
      .get(`/agents/${AGENT_ID}/connector-credentials/surge`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "surge",
      credentials: {
        token: "agent-test-token",
        default_domain: "agent-test-site",
      },
    });
  });

  it("board /credentials endpoint returns surge creds in correct shape", async () => {
    const res = await request(app).get(`/connectors/surge/credentials`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "surge",
    });
    expect(res.body.credentials).toHaveProperty("token");
    expect(res.body.credentials).toHaveProperty("default_domain");
  });

  it("lists surge as a known connector type", async () => {
    const listRes = await request(app).get(`/connectors`);
    expect(listRes.status).toBe(200);
    const types = listRes.body.connectors.map((c: { type: string }) => c.type);
    expect(types).toContain("surge");
  });
});
