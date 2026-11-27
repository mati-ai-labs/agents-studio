import { describe, expect, it } from "vitest";
import type { Request } from "express";
import {
  assertName,
  buildDashboardBrief,
  hashToken,
  normalizeEmails,
  slugify,
  tokenMatchesHash,
} from "../services/company-dashboards.js";
import { canViewDashboard } from "../routes/company-dashboards.js";

const board = (overrides: Partial<Request["actor"]> = {}) =>
  ({ actor: { type: "board", source: "session", isInstanceAdmin: false, userEmail: "pat@example.com", ...overrides } }) as unknown as Request;

describe("company dashboards access", () => {
  it("lets every board member in when there is no allowlist", () => {
    expect(canViewDashboard(board(), { allowedEmails: null })).toBe(true);
    expect(canViewDashboard(board(), { allowedEmails: [] })).toBe(true);
  });

  it("enforces the allowlist but always admits instance admins and agents", () => {
    expect(canViewDashboard(board(), { allowedEmails: ["pat@example.com"] })).toBe(true);
    expect(canViewDashboard(board({ userEmail: "Pat@Example.com" }), { allowedEmails: ["pat@example.com"] })).toBe(true);
    expect(canViewDashboard(board({ userEmail: "eve@example.com" }), { allowedEmails: ["pat@example.com"] })).toBe(false);
    expect(canViewDashboard(board({ userEmail: "eve@example.com", isInstanceAdmin: true }), { allowedEmails: ["pat@example.com"] })).toBe(true);
    expect(canViewDashboard({ actor: { type: "agent" } } as unknown as Request, { allowedEmails: ["pat@example.com"] })).toBe(true);
    expect(canViewDashboard({ actor: { type: "none" } } as unknown as Request, { allowedEmails: null })).toBe(false);
  });
});

describe("company dashboards helpers", () => {
  it("slugifies names", () => {
    expect(slugify("Sales Pipeline — Q4!")).toBe("sales-pipeline-q4");
    expect(slugify("***")).toBe("dashboard");
  });

  it("normalizes and validates viewer emails", () => {
    expect(normalizeEmails(" Pat@Example.com, sam@example.com;pat@example.com ")).toEqual(["pat@example.com", "sam@example.com"]);
    expect(normalizeEmails([])).toBeNull();
    expect(normalizeEmails(null)).toBeNull();
    expect(() => normalizeEmails("not-an-email")).toThrow();
  });

  it("only accepts safe collection and key names", () => {
    expect(assertName("collection", "deals")).toBe("deals");
    expect(assertName("key", "SEA-293:v2")).toBe("SEA-293:v2");
    expect(() => assertName("key", "../etc")).toThrow();
    expect(() => assertName("key", "")).toThrow();
    expect(() => assertName("collection", "a".repeat(129))).toThrow();
  });

  it("matches ingest tokens by hash only", () => {
    const hash = hashToken("dsh_secret");
    expect(tokenMatchesHash(hash, "dsh_secret")).toBe(true);
    expect(tokenMatchesHash(hash, "dsh_other")).toBe(false);
    expect(tokenMatchesHash(null, "dsh_secret")).toBe(false);
    expect(tokenMatchesHash(hash, undefined)).toBe(false);
  });

  it("builds a brief with the publish contract and the request", () => {
    const brief = buildDashboardBrief({
      dashboard: { id: "d1", companyId: "c1", slug: "sales", name: "Sales", currentVersion: 3 },
      kind: "change",
      request: "Add a churn chart",
      collections: [{ collection: "deals", count: 12 }],
    });
    expect(brief.title).toBe("Dashboard change: Sales");
    expect(brief.description).toContain("Add a churn chart");
    expect(brief.description).toContain("/api/companies/c1/dashboards/d1/versions");
    expect(brief.description).toContain("`deals` (12 records)");
    expect(brief.description).toContain("v3");
    const build = buildDashboardBrief({
      dashboard: { id: "d1", companyId: "c1", slug: "sales", name: "Sales", currentVersion: null },
      kind: "build",
      request: "x",
      collections: [],
    });
    expect(build.title).toBe("Build dashboard: Sales");
    expect(build.description).toContain("build it from scratch");
  });
});
