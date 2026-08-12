import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  previewLeases,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { PREVIEW_LEASE_TTL_SECONDS, previewLeaseService } from "../services/previews.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres preview tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("preview lease service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-preview-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(previewLeases);
    await db.delete(workspaceRuntimeServices);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("creates a 30-minute lease, reuses it, and creates a new slug after expiry", async () => {
    const companyId = randomUUID();
    const runtimeServiceId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name: "Preview Company",
      issuePrefix: `PRE-${companyId.slice(0, 8)}`,
    });
    await db.insert(workspaceRuntimeServices).values({
      id: runtimeServiceId,
      companyId,
      scopeType: "project_workspace",
      scopeId: "workspace-1",
      serviceName: "web",
      status: "running",
      lifecycle: "shared",
      command: "pnpm dev",
      cwd: "/tmp/preview-company",
      port: 4173,
      provider: "local_process",
      lastUsedAt: now,
      startedAt: now,
    });

    const service = previewLeaseService(db);
    const first = await service.createForRuntimeService({
      companyId,
      runtimeServiceId,
      baseUrl: "https://paperclip.test",
    });
    expect(first.url).toMatch(/^https:\/\/paperclip\.test\/preview\/web-/);
    expect(first.expiresAt.getTime() - first.createdAt.getTime()).toBe(PREVIEW_LEASE_TTL_SECONDS * 1000);

    const reused = await service.createForRuntimeService({
      companyId,
      runtimeServiceId,
      baseUrl: "https://paperclip.test",
    });
    expect(reused.id).toBe(first.id);

    await db
      .update(previewLeases)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(previewLeases.id, first.id));
    const expired = await service.getBySlug(first.slug, "https://paperclip.test");
    expect(expired?.lease.status).toBe("expired");

    const renewed = await service.createForRuntimeService({
      companyId,
      runtimeServiceId,
      baseUrl: "https://paperclip.test",
    });
    expect(renewed.id).not.toBe(first.id);
    expect(renewed.slug).not.toBe(first.slug);
  });
});
