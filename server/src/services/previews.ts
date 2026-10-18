import { randomBytes } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { companies, previewLeases, workspaceRuntimeServices } from "@paperclipai/db";
import { and, desc, eq, lte } from "drizzle-orm";
import type { PreviewLease } from "@paperclipai/shared";
import { HttpError, badRequest, forbidden, notFound } from "../errors.js";
import { instancePreviewsService } from "./instance-previews.js";

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

export const PREVIEWS_DISABLED_CODE = "previews_disabled";
export const PREVIEWS_DISABLED_MESSAGE =
  "Previews are not enabled for this company. An instance admin can turn them on in Instance settings → Previews.";

export function previewsDisabledError() {
  return forbidden(PREVIEWS_DISABLED_MESSAGE, { code: PREVIEWS_DISABLED_CODE });
}

export function isPreviewsDisabledError(error: unknown): boolean {
  return (
    error instanceof HttpError
    && (error.details as { code?: unknown } | undefined)?.code === PREVIEWS_DISABLED_CODE
  );
}

function sanitizeSlugPart(value: string | null | undefined, fallback: string, maxLength: number): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, maxLength)
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

/**
 * `<company-code>-<service>-<random>`, e.g. `lch-web-3f9a…`. Capped at 54
 * characters so the slug also works as a single DNS label (max 63).
 */
export function createPreviewSlug(companyCode: string | null | undefined, serviceName: string): string {
  const company = sanitizeSlugPart(companyCode, "co", 10);
  const service = sanitizeSlugPart(serviceName, "web", 24);
  return `${company}-${service}-${randomBytes(9).toString("hex")}`;
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
  const instancePreviews = instancePreviewsService(db);

  return {
    /** Throws 403 `previews_disabled` unless the company is switched on in Instance settings → Previews. */
    assertCompanyEnabled: async (companyId: string) => {
      if (!(await instancePreviews.isCompanyEnabled(companyId))) throw previewsDisabledError();
    },

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
      if (!(await instancePreviews.isCompanyEnabled(input.companyId))) throw previewsDisabledError();
      assertLoopbackRuntimeService(runtimeService);
      const companyCode = await db
        .select({ issuePrefix: companies.issuePrefix })
        .from(companies)
        .where(eq(companies.id, input.companyId))
        .then((rows) => rows[0]?.issuePrefix ?? null);

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
              slug: createPreviewSlug(companyCode, runtimeService.serviceName),
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
