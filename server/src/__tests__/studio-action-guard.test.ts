import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { agents, approvals, companies, createDb, guardrailPolicies } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { classifyStudioAction, studioActionGuard, STUDIO_ACTION_APPROVAL_HEADER } from "../middleware/studio-action-guard.js";

describe("classifyStudioAction", () => {
  it("maps API routes to studio actions", () => {
    expect(classifyStudioAction("POST", "/companies/c1/issues", { title: "x" })).toBe("paperclip:issue.create");
    expect(classifyStudioAction("POST", "/companies/c1/issues", { title: "x", parentId: "p" })).toBe("paperclip:issue.create_subissue");
    expect(classifyStudioAction("POST", "/issues/i1/children", {})).toBe("paperclip:issue.create_subissue");
    expect(classifyStudioAction("PATCH", "/issues/i1", { assigneeAgentId: "a" })).toBe("paperclip:issue.assign");
    expect(classifyStudioAction("PATCH", "/issues/i1", { status: "done" })).toBeNull();
    expect(classifyStudioAction("PATCH", "/agents/a1", { adapterConfig: {} })).toBe("paperclip:agent.update");
    expect(classifyStudioAction("PATCH", "/agents/a1/permissions", {})).toBe("paperclip:agent.update_permissions");
    expect(classifyStudioAction("POST", "/companies/c1/agent-hires", {})).toBe("paperclip:agent.create");
    expect(classifyStudioAction("POST", "/agents/a1/terminate", {})).toBe("paperclip:agent.lifecycle");
    expect(classifyStudioAction("POST", "/issues/i1/comments", { body: "hi" })).toBeNull();
    expect(classifyStudioAction("GET", "/companies/c1/issues", null)).toBeNull();
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("studio action guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let agentId = "";
  let handled = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-studio-guard-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    handled = 0;
    await db.execute(sql.raw(`TRUNCATE TABLE "guardrail_violations", "guardrail_policies", "approvals", "activity_log", "agents", "companies" RESTART IDENTITY CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Guard Co",
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({ id: agentId, companyId, name: "CEO", role: "ceo", adapterType: "process", adapterConfig: {}, status: "idle" });
  }

  async function policy(toolNames: string[], action: "require_approval" | "block") {
    await db.insert(guardrailPolicies).values({
      companyId,
      scopeType: "company",
      scopeId: null,
      stage: "action",
      name: action === "block" ? "No agent hires" : "Issues need my approval",
      kind: "restricted_action",
      matcher: { kind: "restricted_action", toolNames },
      action,
      severity: "high",
      enabled: true,
      version: 1,
    });
  }

  function app(actor: Record<string, unknown>) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    server.use(studioActionGuard(db));
    server.all("/{*rest}", (_req, res) => {
      handled += 1;
      res.status(201).json({ ok: true });
    });
    return server;
  }

  const agentActor = () => ({ type: "agent", agentId, companyId, runId: randomUUID(), source: "agent_jwt" });

  it("lets everything through when no policy names the action", async () => {
    await seed();
    await request(app(agentActor())).post(`/companies/${companyId}/issues`).send({ title: "x" }).expect(201);
    expect(handled).toBe(1);
  });

  it("parks an agent's issue creation for approval, then the approved replay goes through exactly once", async () => {
    await seed();
    await policy(["paperclip:issue.create", "paperclip:issue.create_subissue"], "require_approval");
    const actor = agentActor();
    const body = { title: "Decompose the meeting notes", status: "todo" };

    const parked = await request(app(actor)).post(`/companies/${companyId}/issues`).send(body).expect(202);
    expect(parked.body).toMatchObject({ status: "pending_approval", action: "paperclip:issue.create", policyName: "Issues need my approval" });
    expect(handled).toBe(0);

    const [approval] = await db.select().from(approvals);
    expect(approval).toMatchObject({ type: "guardrail_action", status: "pending", requestedByAgentId: agentId });
    expect(approval!.payload).toMatchObject({ studioAction: true, tool: "paperclip:issue.create", request: { method: "POST", path: `/companies/${companyId}/issues`, body } });

    // Same request again while pending: no second approval.
    await request(app(actor)).post(`/companies/${companyId}/issues`).send(body).expect(202);
    expect(await db.select().from(approvals)).toHaveLength(1);

    // Presenting a pending approval does not release the call.
    await request(app(actor)).post(`/companies/${companyId}/issues`).set(STUDIO_ACTION_APPROVAL_HEADER, approval!.id).send(body).expect(403);

    await db.update(approvals).set({ status: "approved" }).where(sql`${approvals.id} = ${approval!.id}`);

    // A different request cannot ride on the approval.
    await request(app(actor)).post(`/companies/${companyId}/issues`).set(STUDIO_ACTION_APPROVAL_HEADER, approval!.id).send({ ...body, title: "Something else" }).expect(403);
    expect(handled).toBe(0);

    // The exact approved request goes through once (this is what the server replay sends)...
    await request(app(actor)).post(`/companies/${companyId}/issues`).set(STUDIO_ACTION_APPROVAL_HEADER, approval!.id).send(body).expect(201);
    expect(handled).toBe(1);
    // ...and the approval is spent.
    await request(app(actor)).post(`/companies/${companyId}/issues`).set(STUDIO_ACTION_APPROVAL_HEADER, approval!.id).send(body).expect(403);
    expect(handled).toBe(1);
  });

  it("parks sub-issue creation separately from top-level issues", async () => {
    await seed();
    await policy(["paperclip:issue.create_subissue"], "require_approval");
    await request(app(agentActor())).post(`/companies/${companyId}/issues`).send({ title: "top" }).expect(201);
    await request(app(agentActor())).post(`/companies/${companyId}/issues`).send({ title: "child", parentId: randomUUID() }).expect(202);
    expect(handled).toBe(1);
  });

  it("blocks an agent from hiring when a block policy names it", async () => {
    await seed();
    await policy(["paperclip:agent.create"], "block");
    const res = await request(app(agentActor())).post(`/companies/${companyId}/agent-hires`).send({ name: "New agent" }).expect(403);
    expect(res.body.code).toBe("guardrail_policy_blocked");
    expect(handled).toBe(0);
  });

  it("tells the agent not to retry after a rejection", async () => {
    await seed();
    await policy(["paperclip:agent.update"], "require_approval");
    const actor = agentActor();
    const body = { adapterConfig: { model: "claude-sonnet-4-6" } };
    await request(app(actor)).patch(`/agents/${agentId}`).send(body).expect(202);
    await db.update(approvals).set({ status: "rejected" });
    const res = await request(app(actor)).patch(`/agents/${agentId}`).send(body).expect(403);
    expect(res.body.code).toBe("guardrail_approval_rejected");
    expect(handled).toBe(0);
  });

  it("never gates a board user", async () => {
    await seed();
    await policy(["paperclip:issue.create"], "block");
    await request(app({ type: "board", userId: "u1", source: "session" })).post(`/companies/${companyId}/issues`).send({ title: "x" }).expect(201);
    expect(handled).toBe(1);
  });
});
