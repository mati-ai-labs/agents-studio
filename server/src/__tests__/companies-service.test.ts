import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("companyService.create", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof companyService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-companies-service-");
    db = createDb(tempDb.connectionString);
    svc = companyService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("retries with a suffixed issue prefix when the base prefix is already taken", async () => {
    await db.insert(companies).values({
      id: randomUUID(),
      name: "Blue Ocean",
      issuePrefix: "BLU",
      requireBoardApprovalForNewAgents: false,
    });

    const created = await svc.create({
      name: "BlueThrone",
      website: "https://bluethrone.io/",
      importantLinks: ["https://example.com/company/bluethrone"],
      budgetMonthlyCents: 0,
    });

    expect(created.issuePrefix).toBe("BLUA");
    expect(created.website).toBe("https://bluethrone.io/");
    expect(created.importantLinks).toEqual(["https://example.com/company/bluethrone"]);
  });
});
