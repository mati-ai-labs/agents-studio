import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, slackEventDeliveries } from "@paperclipai/db";
import { slackEventsRoute } from "../routes/slack-events.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
const SECRET = "test-signing-secret";

describeEmbeddedPostgres("Slack events: one @mention arrives as two events", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let kicks = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-slack-race-");
    db = createDb(tempDb.connectionString);
    process.env.SLACK_SIGNING_SECRET = SECRET;
    delete process.env.SLACK_APP_ID;
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    delete process.env.SLACK_SIGNING_SECRET;
  });

  function app() {
    const a = express();
    a.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
    a.use("/api/connectors/slack", slackEventsRoute(db, () => { kicks += 1; }));
    return a;
  }

  function post(body: Record<string, unknown>) {
    const raw = JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${raw}`).digest("hex")}`;
    return request(app())
      .post("/api/connectors/slack/events")
      .set("content-type", "application/json")
      .set("x-slack-request-timestamp", ts)
      .set("x-slack-signature", sig)
      .send(raw);
  }

  const base = { type: "event_callback", team_id: "T1" };
  const msg = { user: "U1", text: "<@UBOT> what can you do?", channel: "C1", ts: "1700000000.000100" };

  it("processes the mention even when the plain message arrives first", async () => {
    expect((await post({ ...base, event_id: "Ev-msg", event: { ...msg, type: "message" } })).status).toBe(200);
    expect((await post({ ...base, event_id: "Ev-mention", event: { ...msg, type: "app_mention" } })).status).toBe(200);

    const rows = await db.select().from(slackEventDeliveries);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventId: "Ev-mention", eventType: "app_mention", status: "pending", lastError: null });
    expect(kicks).toBeGreaterThan(0);
  });

  it("keeps the mention when it arrives first", async () => {
    await db.delete(slackEventDeliveries);
    const m2 = { ...msg, ts: "1700000000.000200" };
    await post({ ...base, event_id: "Ev-mention-2", event: { ...m2, type: "app_mention" } });
    await post({ ...base, event_id: "Ev-msg-2", event: { ...m2, type: "message" } });
    const rows = await db.select().from(slackEventDeliveries);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventId: "Ev-mention-2", eventType: "app_mention", status: "pending" });
  });
});
