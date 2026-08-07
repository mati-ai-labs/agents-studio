import { randomBytes } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { previewLeases, workspaceRuntimeServices } from "@paperclipai/db";
import { and, desc, eq, lte } from "drizzle-orm";
import type { PreviewLease } from "@paperclipai/shared";
import { badRequest, forbidden, notFound } from "../errors.js";

export const PREVIEW_LEASE_TTL_SECONDS = 30 * 60;

type PreviewLeaseRow = typeof previewLeases.$inferSelect;
type RuntimeServiceRow = typeof workspaceRuntimeServices.$inferSelect;

export interface PreviewLeaseWithRuntimeService {
  lease: PreviewLease;
  runtimeService: RuntimeServiceRow;
}

function normalizeBaseUrl(raw: string | null | undefined): string {
  const fallback = "http://localhost:3100";
  try {
    const parsed = new URL(raw?.trim() || fallback);
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

export function resolvePreviewBaseUrl(raw?: string | null): string {
  return normalizeBaseUrl(
    raw
      ?? process.env.PAPERCLIP_API_URL
      ?? process.env.PAPERCLIP_RUNTIME_API_URL
      ?? null,
  );
}

export function buildPreviewUrl(slug: string, baseUrl?: string | null): string {
  return `${resolvePreviewBaseUrl(baseUrl)}/preview/${encodeURIComponent(slug)}`;
}

function sanitizeSlugPart(value: string | null | undefined): string {
  const normalized = (value ?? "website")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return normalized || "website";
}

function createPreviewSlug(serviceName: string): string {
  return `${sanitizeSlugPart(serviceName)}-${randomBytes(9).toString("hex")}`;
}

function toPreviewLease(row: PreviewLeaseRow, baseUrl?: string | null): PreviewLease {
  return {
    id: row.id,
    companyId: row.companyId,
    runtimeServiceId: row.runtimeServiceId,
    slug: row.slug,
    status: row.status as PreviewLease["status"],
    url: buildPreviewUrl(row.slug, baseUrl),
    expiresAt: row.expiresAt,
    lastAccessedAt: row.lastAccessedAt,
    expiredAt: row.expiredAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function assertLoopbackRuntimeService(runtimeService: RuntimeServiceRow) {
  if (runtimeService.provider !== "local_process") {
    throw badRequest("Only local runtime services can be exposed as Paperclip previews");
  }
  if (!runtimeService.port || runtimeService.port < 1 || runtimeService.port > 65_535) {
    throw badRequest("Runtime service does not have a valid localhost port");
  }
  if (runtimeService.status !== "running") {
    throw badRequest("Runtime service must be running before creating a preview");
  }
}

async function expireLeaseIfDue(db: Db, row: PreviewLeaseRow, now: Date): Promise<PreviewLeaseRow> {
  if (row.status !== "active" || row.expiresAt > now) return row;
  const updated = await db
    .update(previewLeases)
    .set({
      status: "expired",
      expiredAt: now,
      updatedAt: now,
    })
    .where(and(eq(previewLeases.id, row.id), eq(previewLeases.status, "active")))
    .returning()
    .then((rows) => rows[0] ?? null);
  if (updated) {
    await db
      .update(workspaceRuntimeServices)
      .set({ url: null, updatedAt: now })
      .where(eq(workspaceRuntimeServices.id, row.runtimeServiceId));
  }
  return updated ?? { ...row, status: "expired", expiredAt: now, updatedAt: now };
}

export function previewLeaseService(db: Db) {
  return {
    listForCompany: async (companyId: string, baseUrl?: string | null) => {
      const now = new Date();
      const expiredRows = await db
        .update(previewLeases)
        .set({ status: "expired", expiredAt: now, updatedAt: now })
        .where(and(eq(previewLeases.companyId, companyId), eq(previewLeases.status, "active"), lte(previewLeases.expiresAt, now)))
        .returning({ runtimeServiceId: previewLeases.runtimeServiceId });
      await Promise.all(
        [...new Set(expiredRows.map((row) => row.runtimeServiceId))].map((runtimeServiceId) =>
          db
            .update(workspaceRuntimeServices)
            .set({ url: null, updatedAt: now })
            .where(eq(workspaceRuntimeServices.id, runtimeServiceId)),
        ),
      );
      const rows = await db
        .select()
        .from(previewLeases)
        .where(eq(previewLeases.companyId, companyId))
        .orderBy(desc(previewLeases.createdAt));
      return rows.map((row) => toPreviewLease(row, baseUrl));
    },

    getById: async (id: string, baseUrl?: string | null) => {
      const row = await db
        .select()
        .from(previewLeases)
        .where(eq(previewLeases.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      return toPreviewLease(await expireLeaseIfDue(db, row, new Date()), baseUrl);
    },

    getBySlug: async (slug: string, baseUrl?: string | null): Promise<PreviewLeaseWithRuntimeService | null> => {
      const row = await db
        .select({ lease: previewLeases, runtimeService: workspaceRuntimeServices })
        .from(previewLeases)
        .innerJoin(workspaceRuntimeServices, eq(workspaceRuntimeServices.id, previewLeases.runtimeServiceId))
        .where(eq(previewLeases.slug, slug))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;

      const leaseRow = await expireLeaseIfDue(db, row.lease, new Date());
      if (leaseRow.id !== row.lease.id || leaseRow.status !== row.lease.status) {
        row.lease = leaseRow;
      }
      if (row.lease.status === "active") {
        void db
          .update(previewLeases)
          .set({ lastAccessedAt: new Date(), updatedAt: new Date() })
          .where(eq(previewLeases.id, row.lease.id))
          .catch(() => undefined);
      }

      return {
        lease: toPreviewLease(row.lease, baseUrl),
        runtimeService: row.runtimeService,
      };
    },

    createForRuntimeService: async (input: {
      companyId: string;
      runtimeServiceId: string;
      baseUrl?: string | null;
    }) => {
      const runtimeService = await db
        .select()
        .from(workspaceRuntimeServices)
        .where(eq(workspaceRuntimeServices.id, input.runtimeServiceId))
        .then((rows) => rows[0] ?? null);
      if (!runtimeService) throw notFound("Runtime service not found");
      if (runtimeService.companyId !== input.companyId) {
        throw forbidden("Runtime service belongs to another company");
      }
      assertLoopbackRuntimeService(runtimeService);

      const now = new Date();
      const existing = await db
        .select()
        .from(previewLeases)
        .where(
          and(
            eq(previewLeases.companyId, input.companyId),
            eq(previewLeases.runtimeServiceId, input.runtimeServiceId),
            eq(previewLeases.status, "active"),
          ),
        )
        .orderBy(desc(previewLeases.createdAt))
        .then((rows) => rows[0] ?? null);
      if (existing) {
        const activeExisting = await expireLeaseIfDue(db, existing, now);
        if (activeExisting.status === "active") {
          const lease = toPreviewLease(activeExisting, input.baseUrl);
          await db
            .update(workspaceRuntimeServices)
            .set({ url: lease.url, updatedAt: now })
            .where(eq(workspaceRuntimeServices.id, input.runtimeServiceId));
          return lease;
        }
      }

      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const row = await db
            .insert(previewLeases)
            .values({
              companyId: input.companyId,
              runtimeServiceId: input.runtimeServiceId,
              slug: createPreviewSlug(runtimeService.serviceName),
              status: "active",
              expiresAt: new Date(now.getTime() + PREVIEW_LEASE_TTL_SECONDS * 1000),
              createdAt: now,
              updatedAt: now,
            })
            .returning()
            .then((rows) => rows[0]);
          if (!row) throw new Error("Preview lease was not created");
          const lease = toPreviewLease(row, input.baseUrl);
          await db
            .update(workspaceRuntimeServices)
            .set({ url: lease.url, updatedAt: now })
            .where(eq(workspaceRuntimeServices.id, input.runtimeServiceId));
          return lease;
        } catch (error) {
          const isSlugCollision = Boolean(
            error &&
            typeof error === "object" &&
            "code" in error &&
            (error as { code?: unknown }).code === "23505",
          );
          if (!isSlugCollision || attempt === 2) throw error;
        }
      }

      throw new Error("Preview lease was not created");
    },

    revoke: async (id: string, companyId: string, baseUrl?: string | null) => {
      const now = new Date();
      const row = await db
        .update(previewLeases)
        .set({ status: "revoked", revokedAt: now, updatedAt: now })
        .where(
          and(
            eq(previewLeases.id, id),
            eq(previewLeases.companyId, companyId),
            eq(previewLeases.status, "active"),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
      if (row) {
        await db
          .update(workspaceRuntimeServices)
          .set({ url: null, updatedAt: now })
          .where(eq(workspaceRuntimeServices.id, row.runtimeServiceId));
      }
      return row ? toPreviewLease(row, baseUrl) : null;
    },

    expireDue: async (now = new Date()) => {
      const rows = await db
        .update(previewLeases)
        .set({ status: "expired", expiredAt: now, updatedAt: now })
        .where(and(eq(previewLeases.status, "active"), lte(previewLeases.expiresAt, now)))
        .returning({ id: previewLeases.id, runtimeServiceId: previewLeases.runtimeServiceId });
      await Promise.all(
        [...new Set(rows.map((row) => row.runtimeServiceId))].map((runtimeServiceId) =>
          db
            .update(workspaceRuntimeServices)
            .set({ url: null, updatedAt: now })
            .where(eq(workspaceRuntimeServices.id, runtimeServiceId)),
        ),
      );
      return rows.length;
    },
  };
}

export { assertLoopbackRuntimeService };
