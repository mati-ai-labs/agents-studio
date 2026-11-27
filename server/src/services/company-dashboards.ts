// Company dashboards: agent-built, self-contained HTML apps published into Agent Studio.
// Studio keeps every version, serves the current one to a sandboxed iframe, and gives each
// dashboard a JSON record store (collections of keyed documents) that the page reads and
// writes through the host bridge, agents write through the API, and external systems write
// through a per-dashboard ingest token.
import crypto from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companyDashboardFiles,
  companyDashboardRecords,
  companyDashboardRequests,
  companyDashboardVersions,
  companyDashboards,
  issues,
  routines,
} from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { badRequest, conflict, notFound } from "../errors.js";

export const DASHBOARD_HTML_MAX_BYTES = 5 * 1024 * 1024;
export const DASHBOARD_RECORD_MAX_BYTES = 1024 * 1024;
export const DASHBOARD_FILE_MAX_BYTES = 25 * 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DashboardRow = typeof companyDashboards.$inferSelect;

export function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "dashboard";
}

export function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function tokenMatchesHash(hash: string | null, provided: string | null | undefined) {
  if (!hash || !provided) return false;
  const a = Buffer.from(hash);
  const b = Buffer.from(hashToken(provided));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function normalizeEmails(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  const list = Array.isArray(value) ? value : String(value).split(/[\s,;]+/);
  const emails = [...new Set(list.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
  for (const email of emails) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest(`Not an email address: ${email}`);
  }
  return emails.length > 0 ? emails : null;
}

export function assertName(kind: "collection" | "key", value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!NAME_RE.test(text)) {
    throw badRequest(`Invalid ${kind}: use 1-128 letters, digits, _ . : - (starting with a letter or digit)`);
  }
  return text;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecordData(data: unknown) {
  if (data === undefined) throw badRequest("data is required");
  const size = Buffer.byteLength(JSON.stringify(data));
  if (size > DASHBOARD_RECORD_MAX_BYTES) throw badRequest(`Record is ${size} bytes; the limit is ${DASHBOARD_RECORD_MAX_BYTES}`);
}

export function summarizeDashboard(row: DashboardRow) {
  return {
    id: row.id,
    companyId: row.companyId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    status: row.status,
    currentVersion: row.currentVersion,
    allowedEmails: row.allowedEmails ?? null,
    allowedRoutineIds: row.allowedRoutineIds ?? [],
    builderAgentId: row.builderAgentId,
    hasIngestToken: !!row.ingestTokenHash,
    createdByUserId: row.createdByUserId,
    createdByAgentId: row.createdByAgentId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function companyDashboardsService(db: Db, storage?: StorageService) {
  async function getByRef(companyId: string, ref: string) {
    const condition = UUID_RE.test(ref)
      ? eq(companyDashboards.id, ref)
      : eq(companyDashboards.slug, ref.toLowerCase());
    const row = await db
      .select()
      .from(companyDashboards)
      .where(and(eq(companyDashboards.companyId, companyId), condition))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Dashboard not found");
    return row;
  }

  async function uniqueSlug(companyId: string, base: string) {
    const taken = new Set(
      (await db
        .select({ slug: companyDashboards.slug })
        .from(companyDashboards)
        .where(eq(companyDashboards.companyId, companyId)))
        .map((row) => row.slug),
    );
    if (!taken.has(base)) return base;
    for (let n = 2; n < 1000; n += 1) {
      const candidate = `${base}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${base}-${crypto.randomBytes(3).toString("hex")}`;
  }

  async function assertBuilderAgent(companyId: string, agentId: unknown) {
    if (agentId === null || agentId === undefined || agentId === "") return null;
    if (typeof agentId !== "string" || !UUID_RE.test(agentId)) throw badRequest("builderAgentId must be an agent id");
    const agent = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw badRequest("builderAgentId is not an agent in this company");
    return agent.id;
  }

  async function assertRoutines(companyId: string, value: unknown) {
    const ids = Array.isArray(value) ? [...new Set(value.map((v) => String(v)))] : [];
    for (const id of ids) {
      if (!UUID_RE.test(id)) throw badRequest(`Not a routine id: ${id}`);
      const row = await db
        .select({ id: routines.id })
        .from(routines)
        .where(and(eq(routines.id, id), eq(routines.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw badRequest(`Routine ${id} is not in this company`);
    }
    return ids;
  }

  return {
    getByRef,

    async list(companyId: string) {
      return db
        .select()
        .from(companyDashboards)
        .where(eq(companyDashboards.companyId, companyId))
        .orderBy(asc(companyDashboards.name));
    },

    async create(
      companyId: string,
      input: { name: unknown; slug?: unknown; description?: unknown; allowedEmails?: unknown; builderAgentId?: unknown },
      actor: { userId: string | null; agentId: string | null },
    ) {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name || name.length > 120) throw badRequest("name is required (max 120 characters)");
      const requestedSlug = typeof input.slug === "string" && input.slug.trim() ? slugify(input.slug) : null;
      if (requestedSlug) {
        const existing = await db
          .select({ id: companyDashboards.id })
          .from(companyDashboards)
          .where(and(eq(companyDashboards.companyId, companyId), eq(companyDashboards.slug, requestedSlug)))
          .then((rows) => rows[0] ?? null);
        if (existing) throw conflict(`A dashboard with slug "${requestedSlug}" already exists`);
      }
      const slug = requestedSlug ?? (await uniqueSlug(companyId, slugify(name)));
      const [row] = await db
        .insert(companyDashboards)
        .values({
          companyId,
          slug,
          name,
          description: typeof input.description === "string" ? input.description.trim() || null : null,
          allowedEmails: normalizeEmails(input.allowedEmails),
          builderAgentId: (await assertBuilderAgent(companyId, input.builderAgentId)) ?? actor.agentId,
          createdByUserId: actor.userId,
          createdByAgentId: actor.agentId,
        })
        .returning();
      return row!;
    },

    async update(
      dashboard: DashboardRow,
      input: { name?: unknown; description?: unknown; allowedEmails?: unknown; builderAgentId?: unknown; allowedRoutineIds?: unknown },
    ) {
      const patch: Partial<typeof companyDashboards.$inferInsert> = { updatedAt: new Date() };
      if (input.name !== undefined) {
        const name = typeof input.name === "string" ? input.name.trim() : "";
        if (!name || name.length > 120) throw badRequest("name is required (max 120 characters)");
        patch.name = name;
      }
      if (input.description !== undefined) {
        patch.description = typeof input.description === "string" ? input.description.trim() || null : null;
      }
      if (input.allowedEmails !== undefined) patch.allowedEmails = normalizeEmails(input.allowedEmails);
      if (input.allowedRoutineIds !== undefined) {
        patch.allowedRoutineIds = await assertRoutines(dashboard.companyId, input.allowedRoutineIds);
      }
      if (input.builderAgentId !== undefined) {
        patch.builderAgentId = await assertBuilderAgent(dashboard.companyId, input.builderAgentId);
      }
      const [row] = await db
        .update(companyDashboards)
        .set(patch)
        .where(eq(companyDashboards.id, dashboard.id))
        .returning();
      return row!;
    },

    async remove(dashboard: DashboardRow) {
      const files = await db
        .select({ objectKey: companyDashboardFiles.objectKey })
        .from(companyDashboardFiles)
        .where(eq(companyDashboardFiles.dashboardId, dashboard.id));
      for (const file of files) {
        await storage?.deleteObject(dashboard.companyId, file.objectKey).catch(() => undefined);
      }
      await db.delete(companyDashboards).where(eq(companyDashboards.id, dashboard.id));
    },

    async rotateIngestToken(dashboard: DashboardRow) {
      const token = `dsh_${crypto.randomBytes(24).toString("base64url")}`;
      await db
        .update(companyDashboards)
        .set({ ingestTokenHash: hashToken(token), updatedAt: new Date() })
        .where(eq(companyDashboards.id, dashboard.id));
      return token;
    },

    async revokeIngestToken(dashboard: DashboardRow) {
      await db
        .update(companyDashboards)
        .set({ ingestTokenHash: null, updatedAt: new Date() })
        .where(eq(companyDashboards.id, dashboard.id));
    },

    // ---- versions ----

    async publishVersion(
      dashboard: DashboardRow,
      input: { html: unknown; note?: unknown; issueId?: unknown },
      actor: { userId: string | null; agentId: string | null },
    ) {
      if (typeof input.html !== "string" || !input.html.trim()) throw badRequest("html is required");
      const html = input.html;
      const byteSize = Buffer.byteLength(html);
      if (byteSize > DASHBOARD_HTML_MAX_BYTES) {
        throw badRequest(`Dashboard HTML is ${byteSize} bytes; the limit is ${DASHBOARD_HTML_MAX_BYTES}`);
      }
      const issueId = typeof input.issueId === "string" && UUID_RE.test(input.issueId) ? input.issueId : null;
      return db.transaction(async (tx) => {
        // Serialize publishes per dashboard.
        await tx.execute(sql`select id from company_dashboards where id = ${dashboard.id} for update`);
        const latest = await tx
          .select({ version: companyDashboardVersions.version })
          .from(companyDashboardVersions)
          .where(eq(companyDashboardVersions.dashboardId, dashboard.id))
          .orderBy(desc(companyDashboardVersions.version))
          .limit(1)
          .then((rows) => rows[0]?.version ?? 0);
        const version = latest + 1;
        const [row] = await tx
          .insert(companyDashboardVersions)
          .values({
            dashboardId: dashboard.id,
            version,
            html,
            note: typeof input.note === "string" ? input.note.trim().slice(0, 2000) || null : null,
            sha256: crypto.createHash("sha256").update(html).digest("hex"),
            byteSize,
            issueId,
            createdByUserId: actor.userId,
            createdByAgentId: actor.agentId,
          })
          .returning({
            id: companyDashboardVersions.id,
            version: companyDashboardVersions.version,
            createdAt: companyDashboardVersions.createdAt,
          });
        await tx
          .update(companyDashboards)
          .set({ currentVersion: version, status: "active", updatedAt: new Date() })
          .where(eq(companyDashboards.id, dashboard.id));
        return row!;
      });
    },

    async listVersions(dashboard: DashboardRow) {
      return db
        .select({
          id: companyDashboardVersions.id,
          version: companyDashboardVersions.version,
          note: companyDashboardVersions.note,
          byteSize: companyDashboardVersions.byteSize,
          sha256: companyDashboardVersions.sha256,
          issueId: companyDashboardVersions.issueId,
          issueIdentifier: issues.identifier,
          createdByUserId: companyDashboardVersions.createdByUserId,
          createdByAgentId: companyDashboardVersions.createdByAgentId,
          createdAt: companyDashboardVersions.createdAt,
        })
        .from(companyDashboardVersions)
        .leftJoin(issues, eq(issues.id, companyDashboardVersions.issueId))
        .where(eq(companyDashboardVersions.dashboardId, dashboard.id))
        .orderBy(desc(companyDashboardVersions.version));
    },

    async getVersionHtml(dashboard: DashboardRow, version?: number | null) {
      const target = version ?? dashboard.currentVersion;
      if (!target) return null;
      const row = await db
        .select({ version: companyDashboardVersions.version, html: companyDashboardVersions.html })
        .from(companyDashboardVersions)
        .where(and(eq(companyDashboardVersions.dashboardId, dashboard.id), eq(companyDashboardVersions.version, target)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound(`Version ${target} not found`);
      return row;
    },

    async setCurrentVersion(dashboard: DashboardRow, version: number) {
      await this.getVersionHtml(dashboard, version);
      const [row] = await db
        .update(companyDashboards)
        .set({ currentVersion: version, status: "active", updatedAt: new Date() })
        .where(eq(companyDashboards.id, dashboard.id))
        .returning();
      return row!;
    },

    // ---- records ----

    async listCollections(dashboard: DashboardRow) {
      return db
        .select({
          collection: companyDashboardRecords.collection,
          count: sql<number>`count(*)::int`,
          updatedAt: sql<Date>`max(${companyDashboardRecords.updatedAt})`,
        })
        .from(companyDashboardRecords)
        .where(eq(companyDashboardRecords.dashboardId, dashboard.id))
        .groupBy(companyDashboardRecords.collection)
        .orderBy(asc(companyDashboardRecords.collection));
    },

    async listRecords(dashboard: DashboardRow, collectionInput: unknown, opts: { limit?: unknown; offset?: unknown } = {}) {
      const collection = assertName("collection", collectionInput);
      const limit = Math.min(Math.max(Number(opts.limit) || 1000, 1), 5000);
      const offset = Math.max(Number(opts.offset) || 0, 0);
      return db
        .select({
          key: companyDashboardRecords.key,
          data: companyDashboardRecords.data,
          updatedAt: companyDashboardRecords.updatedAt,
        })
        .from(companyDashboardRecords)
        .where(and(eq(companyDashboardRecords.dashboardId, dashboard.id), eq(companyDashboardRecords.collection, collection)))
        .orderBy(asc(companyDashboardRecords.key))
        .limit(limit)
        .offset(offset);
    },

    async getRecord(dashboard: DashboardRow, collectionInput: unknown, keyInput: unknown) {
      const collection = assertName("collection", collectionInput);
      const key = assertName("key", keyInput);
      const row = await db
        .select({ key: companyDashboardRecords.key, data: companyDashboardRecords.data, updatedAt: companyDashboardRecords.updatedAt })
        .from(companyDashboardRecords)
        .where(and(
          eq(companyDashboardRecords.dashboardId, dashboard.id),
          eq(companyDashboardRecords.collection, collection),
          eq(companyDashboardRecords.key, key),
        ))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Record not found");
      return row;
    },

    async putRecords(dashboard: DashboardRow, records: Array<{ collection: unknown; key: unknown; data: unknown }>) {
      if (records.length > 5000) throw badRequest("At most 5000 records per call");
      const values = records.map((record) => {
        assertRecordData(record.data);
        return {
          dashboardId: dashboard.id,
          collection: assertName("collection", record.collection),
          key: assertName("key", record.key),
          data: record.data as unknown,
          updatedAt: new Date(),
        };
      });
      if (values.length === 0) return { written: 0 };
      // Last write wins inside one batch.
      const deduped = [...new Map(values.map((value) => [`${value.collection}\u0000${value.key}`, value])).values()];
      for (let i = 0; i < deduped.length; i += 500) {
        await db
          .insert(companyDashboardRecords)
          .values(deduped.slice(i, i + 500))
          .onConflictDoUpdate({
            target: [companyDashboardRecords.dashboardId, companyDashboardRecords.collection, companyDashboardRecords.key],
            set: { data: sql`excluded.data`, updatedAt: sql`excluded.updated_at` },
          });
      }
      return { written: deduped.length };
    },

    async deleteRecord(dashboard: DashboardRow, collectionInput: unknown, keyInput: unknown) {
      const collection = assertName("collection", collectionInput);
      const key = assertName("key", keyInput);
      const rows = await db
        .delete(companyDashboardRecords)
        .where(and(
          eq(companyDashboardRecords.dashboardId, dashboard.id),
          eq(companyDashboardRecords.collection, collection),
          eq(companyDashboardRecords.key, key),
        ))
        .returning({ id: companyDashboardRecords.id });
      return { deleted: rows.length };
    },

    async clearCollection(dashboard: DashboardRow, collectionInput: unknown) {
      const collection = assertName("collection", collectionInput);
      const rows = await db
        .delete(companyDashboardRecords)
        .where(and(eq(companyDashboardRecords.dashboardId, dashboard.id), eq(companyDashboardRecords.collection, collection)))
        .returning({ id: companyDashboardRecords.id });
      return { deleted: rows.length };
    },

    // ---- files ----

    async listFiles(dashboard: DashboardRow) {
      return db
        .select({
          id: companyDashboardFiles.id,
          name: companyDashboardFiles.name,
          contentType: companyDashboardFiles.contentType,
          byteSize: companyDashboardFiles.byteSize,
          meta: companyDashboardFiles.meta,
          updatedAt: companyDashboardFiles.updatedAt,
        })
        .from(companyDashboardFiles)
        .where(eq(companyDashboardFiles.dashboardId, dashboard.id))
        .orderBy(desc(companyDashboardFiles.updatedAt));
    },

    async putFile(dashboard: DashboardRow, input: { name: unknown; contentType?: unknown; base64: unknown; meta?: unknown }) {
      if (!storage) throw new Error("Dashboard file storage is not configured");
      const name = typeof input.name === "string" ? input.name.trim().replace(/[\\/]/g, "_").slice(0, 200) : "";
      if (!name) throw badRequest("file name is required");
      if (typeof input.base64 !== "string" || !input.base64) throw badRequest("base64 file content is required");
      const body = Buffer.from(input.base64, "base64");
      if (body.length === 0) throw badRequest("file is empty");
      if (body.length > DASHBOARD_FILE_MAX_BYTES) throw badRequest(`File is ${body.length} bytes; the limit is ${DASHBOARD_FILE_MAX_BYTES}`);
      const contentType = typeof input.contentType === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(input.contentType)
        ? input.contentType
        : "application/octet-stream";
      const meta = isPlainRecord(input.meta) ? input.meta : null;
      const stored = await storage.putFile({
        companyId: dashboard.companyId,
        namespace: `dashboards/${dashboard.id}`,
        originalFilename: name,
        contentType,
        body,
      });
      const existing = await db
        .select({ id: companyDashboardFiles.id, objectKey: companyDashboardFiles.objectKey })
        .from(companyDashboardFiles)
        .where(and(eq(companyDashboardFiles.dashboardId, dashboard.id), eq(companyDashboardFiles.name, name)))
        .then((rows) => rows[0] ?? null);
      const values = {
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        objectKey: stored.objectKey,
        meta,
        updatedAt: new Date(),
      };
      if (existing) {
        await db.update(companyDashboardFiles).set(values).where(eq(companyDashboardFiles.id, existing.id));
        if (existing.objectKey !== stored.objectKey) {
          await storage.deleteObject(dashboard.companyId, existing.objectKey).catch(() => undefined);
        }
        return { id: existing.id, name, byteSize: stored.byteSize, replaced: true };
      }
      const [row] = await db
        .insert(companyDashboardFiles)
        .values({ dashboardId: dashboard.id, name, ...values })
        .returning({ id: companyDashboardFiles.id });
      return { id: row!.id, name, byteSize: stored.byteSize, replaced: false };
    },

    async getFile(dashboard: DashboardRow, fileId: string) {
      if (!UUID_RE.test(fileId)) throw notFound("File not found");
      const row = await db
        .select()
        .from(companyDashboardFiles)
        .where(and(eq(companyDashboardFiles.dashboardId, dashboard.id), eq(companyDashboardFiles.id, fileId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("File not found");
      return row;
    },

    async deleteFile(dashboard: DashboardRow, fileId: string) {
      const file = await this.getFile(dashboard, fileId);
      await db.delete(companyDashboardFiles).where(eq(companyDashboardFiles.id, file.id));
      await storage?.deleteObject(dashboard.companyId, file.objectKey).catch(() => undefined);
      return { deleted: 1 };
    },

    // ---- requests ----

    async recordRequest(
      dashboard: DashboardRow,
      input: { issueId: unknown; kind: unknown; request: unknown },
      actor: { userId: string | null },
    ) {
      if (typeof input.issueId !== "string" || !UUID_RE.test(input.issueId)) throw badRequest("issueId is required");
      const issue = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, input.issueId), eq(issues.companyId, dashboard.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw badRequest("issueId is not an issue in this company");
      const kind = input.kind === "build" ? "build" : "change";
      const [row] = await db
        .insert(companyDashboardRequests)
        .values({
          dashboardId: dashboard.id,
          issueId: issue.id,
          kind,
          request: typeof input.request === "string" ? input.request.slice(0, 20000) : "",
          createdByUserId: actor.userId,
        })
        .returning();
      return row!;
    },

    async listRequests(dashboard: DashboardRow) {
      return db
        .select({
          id: companyDashboardRequests.id,
          kind: companyDashboardRequests.kind,
          request: companyDashboardRequests.request,
          createdByUserId: companyDashboardRequests.createdByUserId,
          createdAt: companyDashboardRequests.createdAt,
          issueId: companyDashboardRequests.issueId,
          issueIdentifier: issues.identifier,
          issueStatus: issues.status,
          issueTitle: issues.title,
        })
        .from(companyDashboardRequests)
        .leftJoin(issues, eq(issues.id, companyDashboardRequests.issueId))
        .where(eq(companyDashboardRequests.dashboardId, dashboard.id))
        .orderBy(desc(companyDashboardRequests.createdAt))
        .limit(100);
    },
  };
}

/** The contract handed to the builder agent: what to build, where to publish it, how data works. */
export function buildDashboardBrief(input: {
  dashboard: Pick<DashboardRow, "id" | "companyId" | "slug" | "name" | "currentVersion">;
  kind: "build" | "change";
  request: string;
  collections: Array<{ collection: string; count: number }>;
}) {
  const { dashboard, kind, request, collections } = input;
  const base = `$PAPERCLIP_API_URL/api/companies/${dashboard.companyId}/dashboards/${dashboard.id}`;
  const collectionLines = collections.length
    ? collections.map((c) => `- \`${c.collection}\` (${c.count} records)`).join("\n")
    : "- (none yet)";
  const current = dashboard.currentVersion
    ? `The live version is **v${dashboard.currentVersion}**. Start from it — download it with:\n\n\`\`\`sh\ncurl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "${base}/html" | jq -r .html > dashboard.html\n\`\`\``
    : "There is no published version yet — build it from scratch.";
  return {
    title: kind === "build" ? `Build dashboard: ${dashboard.name}` : `Dashboard change: ${dashboard.name}`,
    description: `${kind === "build" ? "Build" : "Change"} the **${dashboard.name}** company dashboard (\`${dashboard.slug}\`).

## Request

${request.trim()}

## How dashboards work

A dashboard is **one self-contained HTML file** (inline CSS/JS; scripts from cdnjs/jsdelivr/unpkg are fine). Agent Studio shows it in a sandboxed iframe under **Dashboards → ${dashboard.name}**. The page has no cookies and no direct API access; it talks to Studio only through the injected \`window.studio\` object (always available before your scripts run):

\`\`\`js
await studio.info()                        // { dashboard: {id, name, slug, version}, viewer: {name, email} }
await studio.collections()                 // [{ collection, count, updatedAt }]
await studio.list("deals", { limit, offset })  // [{ key, data, updatedAt }] sorted by key
await studio.get("deals", "acme")          // { key, data, updatedAt }  (throws if missing)
await studio.put("deals", "acme", {...})   // upsert one record (viewer edits)
await studio.remove("deals", "acme")       // delete one record
await studio.files()                       // [{ id, name, contentType, byteSize, meta, updatedAt }]
studio.download(fileId)                    // download a file to the viewer
await studio.runRoutine(routineId, { variables, idempotencyKey })  // only routines a board member allowed in Settings
studio.openIssue("THE-123")                // open a task in Studio
studio.onRefresh(() => reload())           // Studio's Refresh button
\`\`\`

Keep the data in records (collections of keyed JSON documents, ≤1 MB each), not hard-coded in the HTML, so the page stays current without republishing. Collection and key names: letters, digits, \`_ . : -\`, max 128 chars. Match the Studio look: system font, neutral greys, light and dark via \`prefers-color-scheme\`.

Existing collections:
${collectionLines}

${current}

## API (run with your \`PAPERCLIP_API_KEY\`)

\`\`\`sh
# write data (upsert, up to 5000 records per call)
curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" \\
  "${base}/records" -d '{"records":[{"collection":"deals","key":"acme","data":{"name":"Acme"}}]}'
# read data
curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "${base}/data/deals"
# upload a downloadable file (≤25 MB; same name replaces it)
jq -n --arg name report.xlsx --arg ct application/vnd.openxmlformats-officedocument.spreadsheetml.sheet \\
  --rawfile b64 <(base64 -w0 report.xlsx) '{name:$name, contentType:$ct, base64:$b64}' | \\
  curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" "${base}/files" -d @-
# publish the page as a new version (becomes live immediately; ≤5 MB)
jq -n --rawfile html dashboard.html --arg note "what changed" --arg issueId "$PAPERCLIP_TASK_ID" \\
  '{html:$html, note:$note, issueId:$issueId}' | \\
  curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" "${base}/versions" -d @-
\`\`\`

External systems (Apps Script, cron jobs) can push records without an agent: a board member creates an ingest token under the dashboard's **Settings**, then the system calls \`POST /api/companies/${dashboard.companyId}/dashboards/${dashboard.id}/ingest\` with \`Authorization: Bearer <token>\` and body \`{"records":[...], "deletes":[{"collection","key"}], "replaceCollections":["deals"], "files":[{"name","contentType","base64"}]}\`.

## Done means

1. Data loaded into records, HTML published as a new version.
2. Fetch \`${base}/html\` back and check it is your version.
3. Comment on this task with the version number and what changed, then mark it done.`,
  };
}
