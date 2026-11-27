import express, { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { badRequest, forbidden, unauthorized } from "../errors.js";
import { logActivity } from "../services/index.js";
import {
  OAuthError,
  oauthService,
  redirectWithParams,
  validateAuthorizeRequest,
  type AuthorizeRequest,
} from "../services/oauth.js";

/**
 * OAuth 2.0 for desktop clients such as Turia. See services/oauth.ts.
 *
 *   GET  /oauth/authorize   describe a request for the consent page (session)
 *   POST /oauth/authorize   approve or deny it; returns the loopback redirect (session)
 *   POST /oauth/token       authorization_code / refresh_token grants (client)
 *   POST /oauth/revoke      RFC 7009 revocation (client)
 *   GET  /oauth/me          who an OAuth token belongs to and which companies it reaches
 *   GET  /oauth/grants      apps the signed-in user has authorized
 *   DELETE /oauth/grants/:id
 */

const decisionSchema = z.object({
  clientId: z.string().trim().min(1),
  redirectUri: z.string().trim().min(1),
  codeChallenge: z.string().trim().min(1),
  codeChallengeMethod: z.string().trim().min(1),
  responseType: z.string().trim().min(1),
  state: z.string().max(512).nullable().optional(),
  decision: z.enum(["approve", "deny"]),
  companyIds: z.array(z.string().trim().min(1)).max(200).optional().default([]),
});

function queryString(req: Request, key: string) {
  const value = req.query[key];
  return typeof value === "string" ? value.trim() : "";
}

function authorizeRequestFromQuery(req: Request): AuthorizeRequest {
  return {
    clientId: queryString(req, "client_id"),
    redirectUri: queryString(req, "redirect_uri"),
    codeChallenge: queryString(req, "code_challenge"),
    codeChallengeMethod: queryString(req, "code_challenge_method") || "S256",
    responseType: queryString(req, "response_type") || "code",
    state: queryString(req, "state") || null,
  };
}

/** A signed-in human in the browser (not a bearer token minting more tokens). */
function sessionUserId(req: Request): string | null {
  if (req.actor.type !== "board" || !req.actor.userId) return null;
  if (req.actor.source !== "session" && req.actor.source !== "local_implicit") return null;
  return req.actor.userId;
}

function bodyString(body: unknown, key: string) {
  if (!body || typeof body !== "object") return "";
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}

function sendOAuthError(res: Response, error: unknown) {
  if (error instanceof OAuthError) {
    res.status(error.code === "invalid_client" ? 401 : 400).json({
      error: error.code,
      error_description: error.message,
    });
    return true;
  }
  return false;
}

export function oauthRoutes(db: Db) {
  const router = Router();
  const svc = oauthService(db);
  const tokenBody = express.urlencoded({ extended: false, limit: "16kb" });

  router.get("/oauth/authorize", async (req, res) => {
    const request = authorizeRequestFromQuery(req);
    const client = validateAuthorizeRequest(request);
    const userId = sessionUserId(req);
    if (!userId) {
      res.json({ client, requiresSignIn: true, user: null, companies: [] });
      return;
    }
    res.json({
      client,
      requiresSignIn: false,
      user: {
        id: userId,
        name: req.actor.userName ?? null,
        email: req.actor.userEmail ?? null,
      },
      companies: await svc.grantableCompanies(userId),
    });
  });

  router.post("/oauth/authorize", async (req, res) => {
    const userId = sessionUserId(req);
    if (!userId) throw unauthorized("Sign in to Agent Studio before authorizing an app");
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid authorization request", parsed.error.issues);
    const input = parsed.data;
    const client = validateAuthorizeRequest(input);

    if (input.decision === "deny") {
      res.json({
        redirectUrl: redirectWithParams(input.redirectUri, { error: "access_denied", state: input.state }),
      });
      return;
    }

    const code = await svc.approve({ ...input, userId });
    for (const companyId of input.companyIds) {
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: userId,
        action: "oauth.authorized",
        entityType: "oauth_client",
        entityId: client.id,
        details: { clientName: client.name },
      }).catch(() => undefined);
    }
    res.json({ redirectUrl: redirectWithParams(input.redirectUri, { code, state: input.state }) });
  });

  router.post("/oauth/token", tokenBody, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const grantType = bodyString(req.body, "grant_type");
      const clientId = bodyString(req.body, "client_id");
      if (grantType === "authorization_code") {
        res.json(
          await svc.exchangeCode({
            code: bodyString(req.body, "code"),
            codeVerifier: bodyString(req.body, "code_verifier"),
            clientId,
            redirectUri: bodyString(req.body, "redirect_uri"),
          }),
        );
        return;
      }
      if (grantType === "refresh_token") {
        res.json(await svc.refresh({ refreshToken: bodyString(req.body, "refresh_token"), clientId }));
        return;
      }
      throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
    } catch (error) {
      if (!sendOAuthError(res, error)) throw error;
    }
  });

  router.post("/oauth/revoke", tokenBody, async (req, res) => {
    const token = bodyString(req.body, "token");
    if (token) await svc.revoke(token);
    res.status(200).json({ revoked: true });
  });

  router.get("/oauth/me", async (req, res) => {
    if (req.actor.type !== "board" || req.actor.source !== "board_key" || !req.actor.userId) {
      throw unauthorized("An OAuth access token is required");
    }
    res.json({
      user: {
        id: req.actor.userId,
        name: req.actor.userName ?? null,
        email: req.actor.userEmail ?? null,
      },
      companies: await svc.companySummaries(req.actor.companyIds ?? []),
    });
  });

  router.get("/oauth/grants", async (req, res) => {
    const userId = sessionUserId(req);
    if (!userId) throw unauthorized();
    res.json(await svc.listGrants(userId));
  });

  router.delete("/oauth/grants/:id", async (req, res) => {
    const userId = sessionUserId(req);
    if (!userId) throw unauthorized();
    const revoked = await svc.revokeGrantForUser(String(req.params.id), userId);
    if (!revoked) throw forbidden("Authorization not found");
    res.json({ revoked: true });
  });

  return router;
}
