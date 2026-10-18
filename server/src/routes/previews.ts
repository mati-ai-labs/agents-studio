import { Router, type Request, type RequestHandler, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { createPreviewLeaseSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { pinRuntimeServiceForPreview } from "../services/workspace-runtime.js";
import {
  previewLeaseService,
  resolvePreviewBaseUrl,
} from "../services/previews.js";
import {
  parsePreviewRequestTarget,
  previewPathPrefix,
  proxyPreviewHostHttp,
  proxyPreviewHttp,
} from "../services/preview-proxy.js";
import { instancePreviewsService } from "../services/instance-previews.js";
import { matchPreviewHost, previewHostOrigin, refreshPreviewDomain } from "../services/preview-hosts.js";
import {
  PREVIEW_AUTH_PATH,
  PREVIEW_SESSION_COOKIE,
  issuePreviewToken,
  readCookie,
  safeReturnPath,
  sessionCookieHeader,
  verifyPreviewToken,
} from "../services/preview-auth.js";
import { assertCompanyAccess, getActorInfo, hasCompanyAccess } from "./authz.js";
import { notFound } from "../errors.js";

function requestPreviewBaseUrl(req: Request) {
  const configured = process.env.PAPERCLIP_API_URL?.trim() || process.env.PAPERCLIP_RUNTIME_API_URL?.trim();
  if (configured) return resolvePreviewBaseUrl(configured);

  const forwardedProto = req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || req.header("host");
  return resolvePreviewBaseUrl(host ? `${forwardedProto || req.protocol}://${host}` : undefined);
}

export function previewApiRoutes(db: Db) {
  const router = Router();
  const previews = previewLeaseService(db);

  router.get("/companies/:companyId/previews", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await previews.listForCompany(companyId, requestPreviewBaseUrl(req)));
  });

  router.post("/companies/:companyId/previews", validate(createPreviewLeaseSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const lease = await previews.createForRuntimeService({
      companyId,
      runtimeServiceId: req.body.runtimeServiceId,
      baseUrl: requestPreviewBaseUrl(req),
    });
    await pinRuntimeServiceForPreview({
      db,
      runtimeServiceId: lease.runtimeServiceId,
      previewUrl: lease.url,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "preview.created",
      entityType: "preview_lease",
      entityId: lease.id,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        runtimeServiceId: lease.runtimeServiceId,
        slug: lease.slug,
        expiresAt: lease.expiresAt.toISOString(),
      },
    });
    res.status(201).json(lease);
  });

  router.get("/previews/:id", async (req, res) => {
    const lease = await previews.getById(req.params.id as string, requestPreviewBaseUrl(req));
    if (!lease) throw notFound("Preview not found");
    assertCompanyAccess(req, lease.companyId);
    res.json(lease);
  });

  router.delete("/previews/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await previews.getById(id, requestPreviewBaseUrl(req));
    if (!existing) throw notFound("Preview not found");
    assertCompanyAccess(req, existing.companyId);
    const lease = await previews.revoke(id, existing.companyId, requestPreviewBaseUrl(req));
    if (!lease) {
      res.status(204).end();
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "preview.revoked",
      entityType: "preview_lease",
      entityId: lease.id,
      agentId: actor.agentId,
      runId: actor.runId,
      details: { runtimeServiceId: lease.runtimeServiceId, slug: lease.slug },
    });
    res.json(lease);
  });

  return router;
}

export function previewProxyRoutes(db: Db) {
  const router = Router();
  const previews = previewLeaseService(db);

  router.use(async (req, res) => {
    const target = parsePreviewRequestTarget(req.originalUrl);
    if (!target) {
      res.status(404).json({ error: "Preview route not found" });
      return;
    }

    const preview = await previews.getBySlug(target.slug);
    if (!preview) {
      res.status(404).json({ error: "Preview not found" });
      return;
    }
    if (preview.lease.status === "expired") {
      res.status(410).json({ error: "Preview expired" });
      return;
    }
    if (preview.lease.status === "revoked") {
      res.status(410).json({ error: "Preview revoked" });
      return;
    }

    assertCompanyAccess(req, preview.lease.companyId);
    await previews.assertCompanyEnabled(preview.lease.companyId);
    // Keep relative links in the application rooted inside the lease. Without
    // the trailing slash, a URL such as `./public/logo.png` resolves to
    // `/preview/public/logo.png` instead of `/preview/{slug}/public/logo.png`.
    const requestPath = new URL(req.originalUrl, "http://paperclip-preview.local").pathname;
    const canonicalRoot = `${previewPathPrefix(target.slug)}/`;
    if (requestPath === previewPathPrefix(target.slug)) {
      res.redirect(308, `${canonicalRoot}${target.search}`);
      return;
    }
    await proxyPreviewHttp(req, res, preview, target);
  });

  return router;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** Small human-readable page for preview hosts (they have no Agent Studio UI). */
function sendPreviewPage(res: Response, status: number, title: string, message: string) {
  res
    .status(status)
    .setHeader("Cache-Control", "no-store")
    .type("html")
    .send(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${escapeHtml(title)}</title></head>` +
        `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#222">` +
        `<h1 style="font-size:1.25rem">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`,
    );
}

/** Public Agent Studio origin, where users have their session. */
export function agentStudioOrigin(): string | null {
  const raw =
    process.env.PAPERCLIP_PUBLIC_URL?.trim() ||
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL?.trim() ||
    process.env.PAPERCLIP_API_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function isHttps(req: Request) {
  const proto = req.header("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol;
  return proto === "https";
}

/**
 * Step 2 of preview sign-in, on the Agent Studio host: check the signed-in
 * user can see the company, then hand a one-time token to the preview host.
 */
export function previewAuthRoutes(db: Db) {
  const router = Router();
  const previews = previewLeaseService(db);
  const instancePreviews = instancePreviewsService(db);

  router.get("/preview-auth/start", async (req, res) => {
    const slug = typeof req.query.slug === "string" ? req.query.slug.toLowerCase() : "";
    const path = safeReturnPath(req.query.path);
    const domain = (await instancePreviews.get()).domain;
    const preview = slug && domain ? await previews.getBySlug(slug) : null;
    if (!domain || !preview) {
      sendPreviewPage(res, 404, "Preview not found", "This preview link doesn't exist.");
      return;
    }

    if (req.actor.type !== "board" || !req.actor.userId) {
      const resume = `/preview-auth?slug=${encodeURIComponent(slug)}&path=${encodeURIComponent(path)}`;
      res.redirect(302, `/login?next=${encodeURIComponent(resume)}`);
      return;
    }
    // Same page for "no such preview" and "not your company" so links can't be probed.
    if (!hasCompanyAccess(req, preview.lease.companyId)) {
      sendPreviewPage(res, 404, "Preview not found", "This preview doesn't exist, or your account can't see the company that owns it.");
      return;
    }
    if (!(await instancePreviews.isCompanyEnabled(preview.lease.companyId))) {
      sendPreviewPage(res, 403, "Previews are off", "Previews are turned off for this company. An instance admin can turn them on in Instance settings → Previews.");
      return;
    }

    const token = issuePreviewToken("handoff", {
      slug,
      userId: req.actor.userId,
      companyId: preview.lease.companyId,
    });
    res.setHeader("Cache-Control", "no-store");
    res.redirect(
      302,
      `${previewHostOrigin(slug, domain)}${PREVIEW_AUTH_PATH}?token=${encodeURIComponent(token)}&path=${encodeURIComponent(path)}`,
    );
  });

  return router;
}

/**
 * Serves `<slug>.<preview domain>`. Mounted before the hostname guard and the
 * Agent Studio auth middleware: these hosts carry the previewed app's own
 * credentials, never Agent Studio's.
 */
export function previewHostMiddleware(db: Db): RequestHandler {
  const previews = previewLeaseService(db);
  void refreshPreviewDomain(db, { force: true });

  return async (req, res, next) => {
    void refreshPreviewDomain(db);
    const slug = matchPreviewHost(req.header("x-forwarded-host") || req.header("host"));
    if (!slug) {
      next();
      return;
    }

    try {
      const preview = await previews.getBySlug(slug);
      if (!preview) {
        sendPreviewPage(res, 404, "Preview not found", "This preview link doesn't exist.");
        return;
      }
      if (preview.lease.status === "revoked") {
        sendPreviewPage(res, 410, "Preview turned off", "This preview link was turned off. Ask the agent for a new one.");
        return;
      }
      if (preview.lease.status === "expired") {
        sendPreviewPage(res, 410, "Preview asleep", "Nobody opened this preview for 30 days. Ask the agent to start the app again; the link stays the same.");
        return;
      }
      const companyId = preview.lease.companyId;
      try {
        await previews.assertCompanyEnabled(companyId);
      } catch {
        sendPreviewPage(res, 403, "Previews are off", "Previews are turned off for this company. An instance admin can turn them on in Instance settings → Previews.");
        return;
      }

      if (req.path === PREVIEW_AUTH_PATH) {
        const handoff = verifyPreviewToken(
          typeof req.query.token === "string" ? req.query.token : null,
          "handoff",
          slug,
        );
        if (!handoff || handoff.c !== companyId) {
          sendPreviewPage(res, 403, "Sign-in link expired", "Open the preview link again to sign in.");
          return;
        }
        const session = issuePreviewToken("session", { slug, userId: handoff.u, companyId });
        res.setHeader("Set-Cookie", sessionCookieHeader(session, isHttps(req)));
        res.setHeader("Cache-Control", "no-store");
        res.redirect(302, safeReturnPath(req.query.path));
        return;
      }

      const session = verifyPreviewToken(readCookie(req.headers.cookie, PREVIEW_SESSION_COOKIE), "session", slug);
      if (!session || session.c !== companyId) {
        const origin = agentStudioOrigin();
        if (!origin) {
          sendPreviewPage(res, 500, "Preview sign-in not configured", "Set PAPERCLIP_PUBLIC_URL on the Agent Studio server.");
          return;
        }
        const signIn = `${origin}/api/preview-auth/start?slug=${encodeURIComponent(slug)}&path=${encodeURIComponent(safeReturnPath(req.originalUrl))}`;
        const method = req.method.toUpperCase();
        if ((method === "GET" || method === "HEAD") && req.accepts(["html", "json"]) === "html") {
          res.setHeader("Cache-Control", "no-store");
          res.redirect(302, signIn);
          return;
        }
        res.status(401).json({ error: "Sign in to view this preview", signInUrl: signIn });
        return;
      }

      await proxyPreviewHostHttp(req, res, preview);
    } catch (err) {
      next(err);
    }
  };
}
