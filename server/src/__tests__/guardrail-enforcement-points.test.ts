import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  documents,
  documentRevisions,
  guardrailPolicies,
  guardrailViolations,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { documentService } from "../services/documents.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres guardrail enforcement tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("guardrail enforcement points", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;
  let issueId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-guardrail-points-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(guardrailViolations);
    await db.delete(activityLog);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(guardrailPolicies);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    companyId = randomUUID();
    agentId = randomUUID();
    issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Enforcement Co",
      issuePrefix: `E${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Enforcement Agent",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      status: "idle",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "G-1",
      title: "Enforcement issue",
      status: "todo",
      priority: "medium",
    });
  }

  async function insertPolicy(overrides: Record<string, unknown> = {}) {
    const [policy] = await db
      .insert(guardrailPolicies)
      .values({
        companyId,
        scopeType: "company",
        scopeId: null,
        stage: "output",
        name: `Policy ${randomUUID().slice(0, 8)}`,
        kind: "regex",
        matcher: { kind: "regex", patterns: ["classified"] },
        action: "block",
        severity: "high",
        enabled: true,
        version: 1,
        ...overrides,
      })
      .returning();
    return policy!;
  }

  // -------------------------------------------------------------------------
  // Output stage: agent-authored board writes
  // -------------------------------------------------------------------------

  it("blocks an agent-authored issue comment that matches an output policy", async () => {
    await seed();
    await insertPolicy({ name: "comment-policy" });

    const service = issueService(db);
    await expect(
      service.addComment(
        issueId,
        "this is classified material",
        { agentId },
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "guardrail_policy_blocked" },
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  it("redacts an agent-authored issue comment in place", async () => {
    await seed();
    await insertPolicy({
      name: "comment-redact-policy",
      action: "redact",
      matcher: { kind: "regex", patterns: ["classified"] },
    });

    const service = issueService(db);
    const comment = await service.addComment(issueId, "this is classified material", { agentId });
    expect(comment?.body).not.toContain("classified");
    expect(comment?.body).toContain("***REDACTED***");
  });

  it("leaves a human-authored issue comment alone", async () => {
    await seed();
    await insertPolicy({ name: "comment-policy" });

    const service = issueService(db);
    const comment = await service.addComment(issueId, "this is classified material", {
      userId: "board-user-1",
    });
    expect(comment?.body).toContain("classified");
  });

  it("blocks an agent-authored issue title that matches an output policy", async () => {
    await seed();
    await insertPolicy({ name: "title-policy" });

    const service = issueService(db);
    await expect(
      service.create(companyId, {
        title: "classified topic",
        description: "safe description",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      } as never),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "guardrail_policy_blocked" },
    });
  });

  it("blocks an agent-authored document body that matches an output policy", async () => {
    await seed();
    await insertPolicy({ name: "document-policy" });

    const service = documentService(db);
    await expect(
      service.upsertIssueDocument({
        issueId,
        key: "plan",
        format: "markdown",
        body: "this is classified material",
        createdByAgentId: agentId,
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "guardrail_policy_blocked" },
    });
  });

  it("records a violation row for a blocked agent-authored write", async () => {
    await seed();
    await insertPolicy({ name: "comment-policy" });

    const service = issueService(db);
    await expect(
      service.addComment(issueId, "this is classified material", { agentId }),
    ).rejects.toBeDefined();

    const violations = await db
      .select()
      .from(guardrailViolations)
      .where(eq(guardrailViolations.companyId, companyId));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      stage: "output",
      actionTaken: "block",
      subjectKind: "issue_comment",
      subjectId: issueId,
      actorAgentId: agentId,
    });
  });

  it("allows an agent-authored write when no output policy matches", async () => {
    await seed();
    await insertPolicy({ name: "comment-policy" });

    const service = issueService(db);
    const comment = await service.addComment(issueId, "ordinary update", { agentId });
    expect(comment?.body).toBe("ordinary update");
  });
});
