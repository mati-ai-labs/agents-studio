import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import {
  inspectPreviewCertificate,
  instancePreviewsService,
  type PreviewCertificateStatus,
} from "../services/instance-previews.js";
import { runPreviewDnsTest } from "./preview-dns.js";
import { assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "./authz.js";

const patchInstancePreviewsSchema = z
  .object({
    domain: z.string().trim().max(253).nullable().optional(),
    dnsZone: z.string().trim().max(253).nullable().optional(),
    dnsToken: z.string().trim().max(4096).nullable().optional(),
    enabledCompanyIds: z.array(z.string().uuid()).max(1000).optional(),
  })
  .strict();

export interface InstancePreviewsRouteOptions {
  inspectCertificate?: (domain: string) => Promise<PreviewCertificateStatus>;
  runDnsTest?: typeof runPreviewDnsTest;
}

export function instancePreviewsRoutes(db: Db, opts: InstancePreviewsRouteOptions = {}) {
  const router = Router();
  const svc = instancePreviewsService(db);
  const inspectCertificate = opts.inspectCertificate ?? ((domain: string) => inspectPreviewCertificate(domain));
  const runDnsTest = opts.runDnsTest ?? runPreviewDnsTest;

  async function buildView() {
    const [settings, companyRows] = await Promise.all([svc.get(), svc.listCompanies()]);
    const certificate = settings.domain ? await inspectCertificate(settings.domain) : null;
    const enabled = new Set(settings.enabledCompanyIds);
    return {
      ...settings,
      certificate,
      companies: companyRows.map((company) => ({ ...company, previewsEnabled: enabled.has(company.id) })),
    };
  }

  router.get("/instance/settings/previews", async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await buildView());
  });

  router.patch("/instance/settings/previews", validate(patchInstancePreviewsSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const before = await svc.get();
    const updated = await svc.update(req.body);
    const actor = getActorInfo(req);
    const beforeEnabled = new Set(before.enabledCompanyIds);
    const afterEnabled = new Set(updated.enabledCompanyIds);
    const toggled = [
      ...updated.enabledCompanyIds.filter((id) => !beforeEnabled.has(id)).map((id) => ({ id, enabled: true })),
      ...before.enabledCompanyIds.filter((id) => !afterEnabled.has(id)).map((id) => ({ id, enabled: false })),
    ];
    await Promise.all(
      toggled.map(({ id, enabled }) =>
        logActivity(db, {
          companyId: id,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          agentApiKeyId: actor.agentApiKeyId,
          action: enabled ? "instance.previews.company_enabled" : "instance.previews.company_disabled",
          entityType: "instance_settings",
          entityId: "previews",
          details: { domain: updated.domain },
        }),
      ),
    );
    res.json(await buildView());
  });

  router.post("/instance/settings/previews/test-dns", async (req, res) => {
    assertInstanceAdmin(req);
    const creds = await svc.getDnsCredentials();
    if (!creds) throw unprocessable("Set the preview domain, DNS zone and DNS API token first");
    const result = await runDnsTest(creds);
    await svc.recordEvent("lastDnsTest", { ok: result.ok, at: new Date().toISOString(), error: result.error });
    res.json(result);
  });

  router.get("/companies/:companyId/previews", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const settings = await svc.get();
    const enabled = settings.domain !== null && settings.enabledCompanyIds.includes(companyId);
    res.json({ enabled, domain: enabled ? settings.domain : null });
  });

  return router;
}
