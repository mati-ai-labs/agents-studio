import { randomBytes } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  PREVIEW_AUTH_PATH,
  issuePreviewToken,
  readCookie,
  safeReturnPath,
  sessionCookieHeader,
  setPreviewAuthKeyForTests,
  stripPreviewSessionCookie,
  verifyPreviewToken,
} from "../services/preview-auth.js";
import { matchPreviewHost } from "../services/preview-hosts.js";

const ids = { slug: "lch-web-0123456789abcdef01", userId: "user-1", companyId: "company-1" };

describe("preview auth tokens", () => {
  beforeEach(() => setPreviewAuthKeyForTests(randomBytes(32)));
  afterAll(() => setPreviewAuthKeyForTests(null));

  it("accepts a session token only for its own slug and kind", () => {
    const token = issuePreviewToken("session", ids);
    expect(verifyPreviewToken(token, "session", ids.slug)).toMatchObject({ u: "user-1", c: "company-1" });
    expect(verifyPreviewToken(token, "session", "other-slug")).toBeNull();
    expect(verifyPreviewToken(token, "handoff", ids.slug)).toBeNull();
  });

  it("rejects tampered, foreign-key and expired tokens", () => {
    const token = issuePreviewToken("session", ids);
    const [body, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), c: "company-2" })).toString("base64url");
    expect(verifyPreviewToken(`${forged}.${mac}`, "session", ids.slug)).toBeNull();
    expect(verifyPreviewToken(`${body}.${mac}.x`, "session", ids.slug)).toBeNull();

    setPreviewAuthKeyForTests(randomBytes(32));
    expect(verifyPreviewToken(token, "session", ids.slug)).toBeNull();

    const old = issuePreviewToken("session", ids, Date.now() - 9 * 60 * 60 * 1000);
    expect(verifyPreviewToken(old, "session", ids.slug)).toBeNull();
  });

  it("lets a handoff token be used once", () => {
    const token = issuePreviewToken("handoff", ids);
    expect(verifyPreviewToken(token, "handoff", ids.slug)).not.toBeNull();
    expect(verifyPreviewToken(token, "handoff", ids.slug)).toBeNull();
  });
});

describe("preview auth helpers", () => {
  it("only returns same-origin paths", () => {
    expect(safeReturnPath("/dashboard?x=1")).toBe("/dashboard?x=1");
    expect(safeReturnPath("//evil.example")).toBe("/");
    expect(safeReturnPath("/\\evil.example")).toBe("/");
    expect(safeReturnPath("https://evil.example")).toBe("/");
    expect(safeReturnPath(`${PREVIEW_AUTH_PATH}?token=x`)).toBe("/");
    expect(safeReturnPath(undefined)).toBe("/");
  });

  it("reads and strips the preview cookie", () => {
    const header = "a=1; agentstudio_preview=tok.en; b=2";
    expect(readCookie(header, "agentstudio_preview")).toBe("tok.en");
    expect(stripPreviewSessionCookie(header)).toBe("a=1; b=2");
    expect(stripPreviewSessionCookie("agentstudio_preview=x")).toBeNull();
    expect(sessionCookieHeader("t", true)).toMatch(/HttpOnly; SameSite=Lax; Max-Age=28800; Secure$/);
    expect(sessionCookieHeader("t", false)).not.toContain("Secure");
  });
});

describe("matchPreviewHost", () => {
  it("matches one label under the preview domain", () => {
    expect(matchPreviewHost("lch-web-abc.agent-preview.site", "agent-preview.site")).toBe("lch-web-abc");
    expect(matchPreviewHost("LCH-WEB-ABC.Agent-Preview.Site:443", "agent-preview.site")).toBe("lch-web-abc");
    expect(matchPreviewHost("a.b.agent-preview.site", "agent-preview.site")).toBeNull();
    expect(matchPreviewHost("agent-preview.site", "agent-preview.site")).toBeNull();
    expect(matchPreviewHost("x.evil-agent-preview.site", "agent-preview.site")).toBeNull();
    expect(matchPreviewHost("agentstudio.matilabs.com", "agent-preview.site")).toBeNull();
    expect(matchPreviewHost("x.agent-preview.site", null)).toBeNull();
  });
});
