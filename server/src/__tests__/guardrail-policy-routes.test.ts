import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  guardrailPolicies,
  guardrailViolations,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { guardrailPolicyRoutes } from "../routes/guardrail-policies.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("guardrail policy routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let otherCompanyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-guardrail-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(guardrailViolations);
    await db.delete(activityLog);
    await db.delete(guardrailPolicies);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function setupApp() {
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values([
      {
        id: companyId,
        name: "Guardrail Co",
        issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other Co",
        issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Runner",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      status: "idle",
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const actor = req.header("x-test-actor");
      req.actor = actor === "board"
        ? {
            type: "board",
            source: "local_implicit",
            userId: "board",
            companyIds: [],
            isInstanceAdmin: true,
          }
        : actor === "none"
          ? { type: "none", source: "none" }
          : {
              type: "agent",
              source: "agent_key",
              agentId,
              companyId: actor === "cross-company" ? otherCompanyId : companyId,
              runId: null,
            };
      next();
    });
    app.use(guardrailPolicyRoutes(db));
    app.use(errorHandler);
    return app;
  }

  const policyBody = {
    scopeType: "company",
    stage: "input",
    name: "Email policy",
    kind: "pii",
    matcher: { kind: "pii", piiTypes: ["email"] },
    action: "redact",
    severity: "medium",
  };

  it("creates, lists, updates and deletes a policy through the API", async () => {
    const app = await setupApp();

    const created = await request(app)
      .post(`/companies/${companyId}/guardrail-policies`)
      .set("x-test-actor", "board")
      .send(policyBody)
      .expect(201);
    expect(created.body).toMatchObject({
      companyId,
      scopeType: "company",
      stage: "input",
      name: "Email policy",
      kind: "pii",
      action: "redact",
      version: 1,
      enabled: true,
    });

    await request(app)
      .get(`/companies/${companyId}/guardrail-policies`)
      .expect(200)
      .expect(({ body }) => expect(body).toHaveLength(1));

    const updated = await request(app)
      .patch(`/companies/${companyId}/guardrail-policies/${created.body.id}`)
      .set("x-test-actor", "board")
      .send({ severity: "critical" })
      .expect(200);
    expect(updated.body).toMatchObject({ severity: "critical", version: 2 });

    await request(app)
      .delete(`/companies/${companyId}/guardrail-policies/${created.body.id}`)
      .set("x-test-actor", "board")
      .expect(200);

    await request(app)
      .get(`/companies/${companyId}/guardrail-policies`)
      .expect(200)
      .expect(({ body }) => expect(body).toHaveLength(0));
  });

  it("rejects a policy whose matcher does not match its kind", async () => {
    const app = await setupApp();
    await request(app)
      .post(`/companies/${companyId}/guardrail-policies`)
      .set("x-test-actor", "board")
      .send({ ...policyBody, matcher: { kind: "regex", patterns: ["x"] } })
      .expect(400);
  });

  it("rejects a policy with an action of allow", async () => {
    const app = await setupApp();
    await request(app)
      .post(`/companies/${companyId}/guardrail-policies`)
      .set("x-test-actor", "board")
      .send({ ...policyBody, action: "allow" })
      .expect(400);
  });

  it("requires a scope id for a non-company scoped policy", async () => {
    const app = await setupApp();
    await request(app)
      .post(`/companies/${companyId}/guardrail-policies`)
      .set("x-test-actor", "board")
      .send({ ...policyBody, scopeType: "agent" })
      .expect(400);
  });

  it("denies an agent without policy administration authority", async () => {
    const app = await setupApp();
    await request(app)
      .post(`/companies/${companyId}/guardrail-policies`)
      .send(policyBody)
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe("guardrail_policy_admin_required"));
  });

  it("denies an unauthenticated caller", async () => {
    const app = await setupApp();
    await request(app)
      .get(`/companies/${companyId}/guardrail-policies`)
      .set("x-test-actor", "none")
      .expect(401);
  });

  it("denies an agent reading another company's policies", async () => {
    const app = await setupApp();
    await request(app)
      .get(`/companies/${companyId}/guardrail-policies`)
      .set("x-test-actor", "cross-company")
      .expect(403);
  });

  it("lists violations filtered by stage", async () => {
    const app = await setupApp();
    await db.insert(guardrailViolations).values([
      {
        companyId,
        stage: "input",
        actionTaken: "block",
        subjectKind: "tool_result",
        resolved: false,
      },
      {
        companyId,
        stage: "output",
        actionTaken: "redact",
        subjectKind: "issue_comment",
        resolved: true,
      },
    ]);

    await request(app)
      .get(`/companies/${companyId}/guardrail-violations?stage=input`)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toHaveLength(1);
        expect(body[0]).toMatchObject({ stage: "input", actionTaken: "block" });
      });

    await request(app)
      .get(`/companies/${companyId}/guardrail-violations?resolved=true`)
      .expect(200)
      .expect(({ body }) => expect(body).toHaveLength(1));
  });

  it("simulates a candidate policy against a sample subject", async () => {
    const app = await setupApp();
    await request(app)
      .post(`/companies/${companyId}/guardrail-policies/simulate`)
      .set("x-test-actor", "board")
      .send({
        stage: "input",
        subject: "reach me at patient@example.com",
        candidatePolicy: policyBody,
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body.action).toBe("redact");
        expect(body.decisive).toMatchObject({ policyName: "Email policy", policyVersion: 0 });
        expect(body.redactedText).not.toContain("patient@example.com");
      });
  });

  it("simulates with no policies and reports allow", async () => {
    const app = await setupApp();
    await request(app)
      .post(`/companies/${companyId}/guardrail-policies/simulate`)
      .set("x-test-actor", "board")
      .send({ stage: "input", subject: "nothing to see" })
      .expect(200)
      .expect(({ body }) => {
        expect(body.action).toBe("allow");
        expect(body.matches).toEqual([]);
      });
  });

  it("logs a policy mutation in the activity log", async () => {
    const app = await setupApp();
    await request(app)
      .post(`/companies/${companyId}/guardrail-policies`)
      .set("x-test-actor", "board")
      .send(policyBody)
      .expect(201);

    const entries = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));
    expect(entries.some((entry) => entry.action === "guardrail_policy.created")).toBe(true);
  });
});
