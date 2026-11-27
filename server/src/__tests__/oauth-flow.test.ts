import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authUsers,
  boardApiKeys,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { oauthRoutes } from "../routes/oauth.js";
import { isAllowedRedirectUri, oauthService } from "../services/oauth.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const REDIRECT = "http://127.0.0.1:53682/oauth/callback";
const VERIFIER = "v".repeat(20) + randomUUID().replace(/-/g, "");
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

describe("isAllowedRedirectUri", () => {
  it("allows only loopback http redirects with a port", () => {
    expect(isAllowedRedirectUri("http://127.0.0.1:4000/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:4000/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://[::1]:4000/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1/cb")).toBe(false);
    expect(isAllowedRedirectUri("https://evil.example:4000/cb")).toBe(false);
    expect(isAllowedRedirectUri("http://127.0.0.1.evil.example:4000/cb")).toBe(false);
    expect(isAllowedRedirectUri("http://user:pw@127.0.0.1:4000/cb")).toBe(false);
    expect(isAllowedRedirectUri("not a url")).toBe(false);
  });
});

describeEmbeddedPostgres("OAuth authorization code + PKCE flow", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const userId = `user-${randomUUID()}`;
  let ownedCompanyId = "";
  let viewerCompanyId = "";
  let otherCompanyId = "";
  let sessionActor: Record<string, unknown> | null = null;

  /** App with the real actor middleware; a fake session stands in for better-auth. */
  function app() {
    const server = express();
    server.use(express.json());
    server.use(
      actorMiddleware(db, {
        deploymentMode: "authenticated",
        resolveSession: async () =>
          sessionActor ? ({ user: sessionActor, session: { id: "s" } } as never) : null,
      }),
    );
    const api = express.Router();
    api.use(oauthRoutes(db));
    api.get("/whoami", (req, res) => res.json(req.actor));
    server.use("/api", api);
    server.use(errorHandler);
    return server;
  }

  const authorizeBody = (companyIds: string[]) => ({
    clientId: "turia",
    redirectUri: REDIRECT,
    codeChallenge: CHALLENGE,
    codeChallengeMethod: "S256",
    responseType: "code",
    state: "xyz",
    decision: "approve",
    companyIds,
  });

  async function authorize(companyIds: string[]) {
    sessionActor = { id: userId, name: "Aditya", email: "a@example.com" };
    const res = await request(app()).post("/api/oauth/authorize").send(authorizeBody(companyIds));
    sessionActor = null;
    return res;
  }

  async function codeFor(companyIds: string[]) {
    const res = await authorize(companyIds);
    expect(res.status).toBe(200);
    const url = new URL(res.body.redirectUrl);
    expect(url.origin + url.pathname).toBe(REDIRECT);
    expect(url.searchParams.get("state")).toBe("xyz");
    return url.searchParams.get("code")!;
  }

  const exchange = (code: string, verifier = VERIFIER) =>
    request(app())
      .post("/api/oauth/token")
      .type("form")
      .send({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: "turia", redirect_uri: REDIRECT });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-oauth-flow-");
    db = createDb(tempDb.connectionString);
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "Aditya", email: "a@example.com", emailVerified: true, createdAt: now, updatedAt: now });
    // An instance admin: OAuth tokens must still be limited to the granted companies.
    await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
    const make = async (name: string) =>
      (await db.insert(companies).values({ name, issuePrefix: `O${randomUUID().slice(0, 5).toUpperCase()}` }).returning())[0]!.id;
    ownedCompanyId = await make("Acme");
    viewerCompanyId = await make("Viewer Co");
    otherCompanyId = await make("Not Mine");
    await db.insert(companyMemberships).values([
      { companyId: ownedCompanyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" },
      { companyId: viewerCompanyId, principalType: "user", principalId: userId, status: "active", membershipRole: "viewer" },
    ]);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("asks an anonymous browser to sign in and rejects bad requests", async () => {
    const ok = await request(app()).get(
      `/api/oauth/authorize?client_id=turia&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${CHALLENGE}&code_challenge_method=S256&response_type=code`,
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ requiresSignIn: true, client: { id: "turia", name: "Turia" } });

    const badRedirect = await request(app()).get(
      `/api/oauth/authorize?client_id=turia&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&code_challenge=${CHALLENGE}`,
    );
    expect(badRedirect.status).toBe(400);
    const badClient = await request(app()).get(
      `/api/oauth/authorize?client_id=nope&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${CHALLENGE}`,
    );
    expect(badClient.status).toBe(400);
  });

  it("lists the signed-in user's companies on the consent page", async () => {
    const rows = await oauthService(db).grantableCompanies(userId);
    expect(rows.map((row) => [row.name, row.canGrant])).toEqual([
      ["Acme", true],
      ["Viewer Co", false],
    ]);
  });

  it("refuses to grant companies the user is not a writing member of", async () => {
    expect((await authorize([otherCompanyId])).status).toBe(400);
    expect((await authorize([viewerCompanyId])).status).toBe(400);
    expect((await authorize([])).status).toBe(400);
  });

  it("does not let a bearer token approve a new grant", async () => {
    const tokens = (await exchange(await codeFor([ownedCompanyId]))).body;
    const res = await request(app())
      .post("/api/oauth/authorize")
      .set("authorization", `Bearer ${tokens.access_token}`)
      .send(authorizeBody([ownedCompanyId]));
    expect(res.status).toBe(401);
  });

  it("exchanges a code for a company-scoped token, once, with the right verifier", async () => {
    const code = await codeFor([ownedCompanyId]);
    const wrong = await exchange(code, "w".repeat(43));
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe("invalid_grant");

    const res = await exchange(code);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      token_type: "Bearer",
      user: { id: userId, email: "a@example.com" },
      companies: [{ id: ownedCompanyId, name: "Acme" }],
    });
    expect(res.body.access_token).toMatch(/^pcp_board_/);
    expect(res.body.refresh_token).toMatch(/^pcp_oauth_refresh_/);

    const actor = (await request(app()).get("/api/whoami").set("authorization", `Bearer ${res.body.access_token}`)).body;
    expect(actor).toMatchObject({ type: "board", source: "board_key", isInstanceAdmin: false, companyIds: [ownedCompanyId] });
    expect(actor.memberships.map((row: { companyId: string }) => row.companyId)).toEqual([ownedCompanyId]);

    const me = await request(app()).get("/api/oauth/me").set("authorization", `Bearer ${res.body.access_token}`);
    expect(me.body.companies).toEqual([expect.objectContaining({ id: ownedCompanyId, name: "Acme" })]);

    // Replaying the code revokes what it produced.
    const replay = await exchange(code);
    expect(replay.status).toBe(400);
    const after = await request(app()).get("/api/whoami").set("authorization", `Bearer ${res.body.access_token}`);
    expect(after.body.type).toBe("none");
  });

  it("rotates tokens on refresh and stops after the user revokes the key", async () => {
    const first = (await exchange(await codeFor([ownedCompanyId]))).body;
    const refresh = (token: string) =>
      request(app()).post("/api/oauth/token").type("form").send({ grant_type: "refresh_token", refresh_token: token, client_id: "turia" });

    const second = await refresh(first.refresh_token);
    expect(second.status).toBe(200);
    expect(second.body.access_token).not.toBe(first.access_token);
    expect((await request(app()).get("/api/whoami").set("authorization", `Bearer ${first.access_token}`)).body.type).toBe("none");
    expect((await refresh(first.refresh_token)).status).toBe(400);

    // The user revokes the "Turia (OAuth)" key in Agent Studio.
    const keyRows = await db.select().from(boardApiKeys).where(eq(boardApiKeys.name, "Turia (OAuth)"));
    for (const row of keyRows) await db.update(boardApiKeys).set({ revokedAt: new Date() }).where(eq(boardApiKeys.id, row.id));
    const dead = await refresh(second.body.refresh_token);
    expect(dead.status).toBe(400);
    expect(dead.body.error).toBe("invalid_grant");
  });

  it("revokes a grant through the revocation endpoint", async () => {
    const tokens = (await exchange(await codeFor([ownedCompanyId]))).body;
    await request(app()).post("/api/oauth/revoke").type("form").send({ token: tokens.refresh_token }).expect(200);
    expect((await request(app()).get("/api/whoami").set("authorization", `Bearer ${tokens.access_token}`)).body.type).toBe("none");
  });
});
