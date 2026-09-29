import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import {
  redactRestrictedPayload,
  redactRoutinePayload,
  restrictedOperatorGuard,
} from "../middleware/restricted-operator-guard.js";

function buildApp(actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  const api = express.Router();
  api.use(restrictedOperatorGuard());
  api.get("/companies/:companyId/skills", (_req, res) => res.json([{ id: "s1" }]));
  api.get("/agents/:id/instructions-bundle", (_req, res) => res.json({ files: [] }));
  api.post("/companies/:companyId/export", (_req, res) => res.json({ ok: true }));
  api.get("/agents/:id", (_req, res) =>
    res.json({
      id: "a1",
      adapterConfig: { model: "x", promptTemplate: "secret", instructionsFilePath: "/p", paperclipSkillSync: {} },
    }),
  );
  api.patch("/agents/:id", (req, res) => res.json({ received: req.body }));
  api.get("/routines/:id", (_req, res) =>
    res.json({
      id: "r1",
      title: "Daily digest",
      description: "secret routine prompt",
      triggers: [
        { id: "t1", kind: "schedule", cronExpression: "0 9 * * *" },
        { id: "t2", kind: "webhook", publicId: "pub", secretId: "sec" },
      ],
    }),
  );
  api.patch("/routines/:id", (req, res) => res.json({ received: req.body }));
  api.post("/routines/:id/triggers", (_req, res) => res.json({ ok: true }));
  api.get("/routines/:id/revisions", (_req, res) => res.json([]));
  api.post("/companies/:companyId/routines", (_req, res) => res.json({ ok: true }));
  api.get("/heartbeat-runs/:runId", (_req, res) =>
    res.json({ id: "run1", status: "succeeded", stdoutExcerpt: "out", stderrExcerpt: "err", contextSnapshot: { prompt: "p" } }),
  );
  api.get("/heartbeat-runs/:runId/log", (_req, res) => res.json({ content: "log" }));
  api.get("/heartbeat-runs/:runId/events", (_req, res) => res.json([]));
  api.get("/connectors", (_req, res) => res.json([]));
  api.get("/companies/:companyId/secrets", (_req, res) => res.json([]));
  api.post("/companies/:companyId/secrets", (_req, res) => res.json({ ok: true }));
  api.patch("/environments/:id", (_req, res) => res.json({ ok: true }));
  api.get("/companies/:companyId/members", (_req, res) => res.json([]));
  api.patch("/companies/:companyId/members/:memberId", (_req, res) => res.json({ ok: true }));
  api.patch("/companies/:companyId/members/:memberId/permissions", (_req, res) => res.json({ ok: true }));
  api.post("/companies/:companyId/members/:memberId/archive", (_req, res) => res.json({ ok: true }));
  app.use("/api", api);
  app.use(errorHandler);
  return app;
}

const restricted = {
  type: "board" as const,
  userId: "u1",
  companyIds: ["c1"],
  isInstanceAdmin: false,
  isRestricted: true,
  source: "session" as const,
};

describe("restrictedOperatorGuard", () => {
  it("blocks skills, instructions, and export routes for restricted users", async () => {
    const app = buildApp(restricted);
    await request(app).get("/api/companies/c1/skills").expect(403);
    await request(app).get("/api/agents/a1/instructions-bundle").expect(403);
    await request(app).post("/api/companies/c1/export").send({}).expect(403);
  });

  it("redacts prompt and skill keys from agent responses", async () => {
    const res = await request(buildApp(restricted)).get("/api/agents/a1").expect(200);
    expect(res.body.adapterConfig).toEqual({ model: "x" });
  });

  it("strips prompt fields from agent updates and rejects full adapter replacement", async () => {
    const app = buildApp(restricted);
    const res = await request(app)
      .patch("/api/agents/a1")
      .send({ name: "n", adapterConfig: { model: "y", promptTemplate: "evil" }, instructionsBundle: { x: 1 } })
      .expect(200);
    expect(res.body.received).toEqual({ name: "n", adapterConfig: { model: "y" } });
    await request(app).patch("/api/agents/a1").send({ replaceAdapterConfig: true, adapterConfig: {} }).expect(403);
  });

  it("leaves unrestricted users untouched", async () => {
    const app = buildApp({ ...restricted, isRestricted: false });
    await request(app).get("/api/companies/c1/skills").expect(200);
    const res = await request(app).get("/api/agents/a1").expect(200);
    expect(res.body.adapterConfig.promptTemplate).toBe("secret");
  });

  it("hides routine prompts and all triggers", async () => {
    const app = buildApp(restricted);
    const res = await request(app).get("/api/routines/r1").expect(200);
    expect(res.body).toEqual({ id: "r1", title: "Daily digest", triggers: [] });
    const patched = await request(app).patch("/api/routines/r1").send({ title: "x", description: "overwrite" }).expect(200);
    expect(patched.body.received).toEqual({ title: "x" });
    await request(app).post("/api/routines/r1/triggers").send({ kind: "webhook" }).expect(403);
    await request(app).post("/api/routines/r1/triggers").send({ kind: "schedule" }).expect(403);
    await request(app).get("/api/routines/r1/revisions").expect(403);
  });

  it("returns only the run summary, never logs or output", async () => {
    const app = buildApp(restricted);
    const res = await request(app).get("/api/heartbeat-runs/run1").expect(200);
    expect(res.body).toEqual({ id: "run1", status: "succeeded" });
    await request(app).get("/api/heartbeat-runs/run1/log").expect(403);
    await request(app).get("/api/heartbeat-runs/run1/events").expect(403);
  });

  it("blocks connectors and secret/environment changes but keeps secret lists readable", async () => {
    const app = buildApp(restricted);
    await request(app).get("/api/connectors").expect(403);
    await request(app).get("/api/companies/c1/secrets").expect(200);
    await request(app).post("/api/companies/c1/secrets").send({}).expect(403);
    await request(app).patch("/api/environments/e1").send({}).expect(403);
  });

  it("keeps access view-only", async () => {
    const app = buildApp(restricted);
    await request(app).get("/api/companies/c1/members").expect(200);
    await request(app).patch("/api/companies/c1/members/m1").send({ membershipRole: "owner" }).expect(403);
    await request(app).patch("/api/companies/c1/members/m1/permissions").send({ grants: [] }).expect(403);
    await request(app).post("/api/companies/c1/members/m1/archive").send({}).expect(403);
  });

  it("blocks routine creation", async () => {
    await request(buildApp(restricted)).post("/api/companies/c1/routines").send({ title: "t" }).expect(403);
    await request(buildApp({ ...restricted, isRestricted: false }))
      .post("/api/companies/c1/routines")
      .send({ title: "t" })
      .expect(200);
  });

  it("hides the prompt body of routine-created issues everywhere", () => {
    expect(
      redactRestrictedPayload([
        { id: "i1", originKind: "routine_execution", title: "Run", description: "routine prompt" },
        { id: "i2", originKind: "manual", title: "Task", description: "normal body" },
      ]),
    ).toEqual([
      { id: "i1", originKind: "routine_execution", title: "Run" },
      { id: "i2", originKind: "manual", title: "Task", description: "normal body" },
    ]);
  });

  it("only applies routine redaction on routine endpoints", () => {
    expect(redactRoutinePayload({ description: "d", triggers: [{ kind: "schedule" }] })).toEqual({ triggers: [] });
  });

  it("preserves Date values while redacting", () => {
    const createdAt = new Date("2026-09-01T00:00:00.000Z");
    const out = redactRestrictedPayload({ createdAt, items: [{ createdAt }] }) as {
      createdAt: Date;
      items: Array<{ createdAt: Date }>;
    };
    expect(out.createdAt).toBe(createdAt);
    expect(out.items[0]!.createdAt).toBe(createdAt);
  });

  it("redacts nested adapterConfig objects", () => {
    expect(
      redactRestrictedPayload({ revisions: [{ after: { adapterConfig: { promptTemplate: "p", cwd: "/w" } } }] }),
    ).toEqual({ revisions: [{ after: { adapterConfig: { cwd: "/w" } } }] });
  });
});
