import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

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

function connectorKey(companyId: string, type: string) {
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

vi.mock("../services/connector-registry.js", () => ({
  connectorRegistryService: () => ({
    listByCompanyForUser: async (companyId: string) =>
      Array.from(fakeRows.values()).filter((row) => row.companyId === companyId),
    getByType: async (companyId: string, type: string) =>
      fakeRows.get(connectorKey(companyId, type)) ?? null,
    upsert: async (input: {
      companyId: string;
      type: string;
      userId?: string | null;
      config?: Record<string, unknown>;
      status?: string;
      credentials?: { accessToken: string; refreshToken?: string; expiry?: number };
      displayName?: string;
    }) => {
      const key = connectorKey(input.companyId, input.type);
      const existing = fakeRows.get(key) ?? makeRow(input.companyId, input.type);
      const next: FakeRow = {
        ...existing,
        userId: input.userId ?? existing.userId,
        config: input.config ?? existing.config,
        status: input.status ?? existing.status,
        credentialsEncrypted: input.credentials
          ? `STUBENC::${JSON.stringify(input.credentials)}`
          : existing.credentialsEncrypted,
        displayName: input.displayName ?? existing.displayName,
        lastError: input.status === "connected" ? null : existing.lastError,
        connectedAt: input.status === "connected" ? (existing.connectedAt ?? new Date()) : existing.connectedAt,
        updatedAt: new Date(),
      };
      fakeRows.set(key, next);
      return next;
    },
    updateStatus: async (companyId: string, type: string, status: string, lastError?: string) => {
      const key = connectorKey(companyId, type);
      const existing = fakeRows.get(key) ?? makeRow(companyId, type);
      const next = {
        ...existing,
        status,
        lastError: lastError ?? null,
        updatedAt: new Date(),
      };
      fakeRows.set(key, next);
      return next;
    },
    disconnect: async (companyId: string, type: string) => {
      const key = connectorKey(companyId, type);
      const existing = fakeRows.get(key);
      if (!existing) return null;
      const next = {
        ...existing,
        status: "disconnected",
        credentialsEncrypted: null,
        lastError: null,
        disconnectedAt: new Date(),
        updatedAt: new Date(),
      };
      fakeRows.set(key, next);
      return next;
    },
    disconnectForUser: async (companyId: string, type: string, userId: string) => {
      const key = connectorKey(companyId, type);
      const existing = fakeRows.get(key);
      if (!existing) return null;
      const next = {
        ...existing,
        userId,
        status: "disconnected",
        credentialsEncrypted: null,
        lastError: null,
        disconnectedAt: new Date(),
        updatedAt: new Date(),
      };
      fakeRows.set(key, next);
      return next;
    },
    getCredentialsAsync: async (companyId: string, type: string) => {
      const row = fakeRows.get(connectorKey(companyId, type));
      if (!row?.credentialsEncrypted) return null;
      return JSON.parse(row.credentialsEncrypted.replace(/^STUBENC::/, "")) as {
        accessToken: string;
        refreshToken?: string;
        expiry?: number;
      };
    },
    getCredentialsForAgentAsync: async (companyId: string, type: string) => {
      const row = fakeRows.get(connectorKey(companyId, type));
      if (!row?.credentialsEncrypted) return null;
      return {
        credentials: JSON.parse(row.credentialsEncrypted.replace(/^STUBENC::/, "")) as {
          accessToken: string;
          refreshToken?: string;
          expiry?: number;
        },
        sourceUserId: row.userId,
      };
    },
  }),
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

interface ActorContext {
  type: "board";
  companyIds?: string[];
  userId?: string;
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
      userId: "board-user-1",
      companyIds: [companyId],
      source: "test",
    };
    next();
  };
}

describe("slack connector routes", () => {
  const COMPANY_ID = "11111111-1111-1111-1111-111111111111";
  const originalFetch = global.fetch;
  const fetchMock = vi.fn();
  let app: express.Express;

  beforeAll(() => {
    process.env.SLACK_CLIENT_ID = "slack-client-id";
    process.env.SLACK_CLIENT_SECRET = "slack-client-secret";
    global.fetch = fetchMock as typeof fetch;

    app = express();
    app.use(express.json());
    const fakeDb = new Proxy({}, {
      get: () => () => ({
        from: () => ({
          limit: () => Promise.resolve([]),
          where: () => ({ limit: () => Promise.resolve([]) }),
        }),
        where: () => ({ limit: () => Promise.resolve([]) }),
      }),
    }) as never;
    app.use(injectBoardActor(COMPANY_ID));
    app.use("/connectors", createConnectorsRouter({
      db: fakeDb,
      getBaseUrl: () => "http://localhost",
    }));
  });

  beforeEach(() => {
    fakeRows.clear();
    fetchMock.mockReset();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("stores Slack installs at company scope with workspace metadata", async () => {
    const connect = await request(app)
      .post(`/connectors/slack/connect?companyId=${COMPANY_ID}`)
      .send({});

    expect(connect.status).toBe(200);
    expect(connect.body.state).toEqual(expect.any(String));

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        access_token: "xoxb-slack-token",
        scope: "channels:read,chat:write,chat:write.public,users:read,team:read",
        bot_user_id: "B123",
        team: { id: "T123", name: "Paperclip" },
        authed_user: { id: "U123" },
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        team: "Paperclip",
        team_id: "T123",
        url: "https://paperclip.slack.com/",
        user_id: "B123",
      }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const callback = await request(app)
      .get(`/connectors/slack/callback?state=${encodeURIComponent(connect.body.state)}&code=oauth-code`);

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toContain("connected=slack");

    const row = fakeRows.get(connectorKey(COMPANY_ID, "slack"));
    expect(row).toBeDefined();
    expect(row?.userId).toBeNull();
    expect(row?.status).toBe("connected");
    expect(row?.displayName).toBe("Paperclip");
    expect(row?.config).toMatchObject({
      workspaceId: "T123",
      workspaceName: "Paperclip",
      workspaceUrl: "https://paperclip.slack.com/",
      botUserId: "B123",
      installedByUserId: "U123",
      mcpEnabled: true,
    });
  });

  it("completes the OAuth callback when Slack auth.test returns HTTP 408", async () => {
    const connect = await request(app)
      .post(`/connectors/slack/connect?companyId=${COMPANY_ID}`)
      .send({});

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        access_token: "xoxb-slack-token",
        scope: "channels:read,chat:write,chat:write.public,users:read,team:read",
        bot_user_id: "B123",
        team: { id: "T123", name: "Paperclip" },
        authed_user: { id: "U123" },
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response("", { status: 408 }));

    const callback = await request(app)
      .get(`/connectors/slack/callback?state=${encodeURIComponent(connect.body.state)}&code=oauth-code`);

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toContain("connected=slack");
    expect(fakeRows.get(connectorKey(COMPANY_ID, "slack"))?.status).toBe("connected");
  });

  it("rejects callback route mismatches for Slack installs", async () => {
    const connect = await request(app)
      .post(`/connectors/slack/connect?companyId=${COMPANY_ID}`)
      .send({});

    const callback = await request(app)
      .get(`/connectors/google_workspace/callback?state=${encodeURIComponent(connect.body.state)}&code=oauth-code`);

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toContain("error=invalid_state");
    expect(fakeRows.get(connectorKey(COMPANY_ID, "slack"))?.status).toBe("error");
  });

  it("lists joined Slack channels for the connected workspace", async () => {
    fakeRows.set(connectorKey(COMPANY_ID, "slack"), {
      ...makeRow(COMPANY_ID, "slack"),
      status: "connected",
      credentialsEncrypted: `STUBENC::${JSON.stringify({ accessToken: "xoxb-slack-token" })}`,
      displayName: "Paperclip",
      config: {
        workspaceId: "T123",
        workspaceName: "Paperclip",
        workspaceUrl: "https://paperclip.slack.com/",
        mcpEnabled: true,
      },
    });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      channels: [
        { id: "C999", name: "random", is_private: false, is_member: false, num_members: 30 },
        { id: "C123", name: "ship-alerts", is_private: false, is_member: true, num_members: 12 },
        { id: "C789", name: "general", is_private: false, is_member: false, num_members: 150 },
      ],
      response_metadata: { next_cursor: "" },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const response = await request(app)
      .get(`/connectors/slack/channels?companyId=${COMPANY_ID}`);

    expect(response.status).toBe(200);
    expect(response.body.workspace).toMatchObject({
      workspaceId: "T123",
      workspaceName: "Paperclip",
      workspaceUrl: "https://paperclip.slack.com/",
    });
    // Channels come back in API order: C789, C999, C123 (none are private).
    expect(response.body.channels).toEqual([
      expect.objectContaining({ id: "C789", name: "general", channelType: "public" }),
      expect.objectContaining({ id: "C999", name: "random", channelType: "public" }),
      expect.objectContaining({ id: "C123", name: "ship-alerts", channelType: "public" }),
    ]);
    // Public-only: private channels are excluded by the API filter
    // (types=public_channel) and a defense-in-depth `is_private` skip in
    // listSlackChannels.
  });
});
