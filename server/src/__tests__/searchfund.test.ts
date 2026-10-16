import { describe, expect, it } from "vitest";
import type { Request } from "express";
import {
  issueFromFilename,
  nicheContext,
  normalizeSheetRows,
  parseTaxonomyRows,
  rankScores,
  readSearchfundConfig,
  tokensMatch,
} from "../services/searchfund.js";
import { canViewSearchfund } from "../routes/searchfund.js";

describe("searchfund taxonomy sync", () => {
  const headers = [
    "Taxonomy ID", "Domain", "Niche", "▶ RUN AGENT WORKFLOW", "Run Status", "Research Task",
    "Micro-Niche (Short Name)", "Agent Research Status", "NAICS",
  ];

  it("parses sheet rows, drops sheet-only control columns and skips blank ids", () => {
    const rows = parseTaxonomyRows({
      headers,
      rows: [
        ["SF-001", "Compliance", "Trade", false, "Research started · 1 Oct", "SEA-293", "Forced Labour", "In Progress", "541611"],
        ["", "x", "y", false, "", "", "", "", ""],
        ["SF-002", "Environmental", "Site", false, "", "", "", "", ""],
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      taxonomyId: "SF-001",
      shortName: "Forced Labour",
      researchStatus: "In Progress",
      runStatus: "Research started · 1 Oct",
      sheetRow: 2,
    });
    expect(rows[0].fields.map((f) => f.header)).not.toContain("RUN AGENT WORKFLOW");
    // Research Task is kept: it links the niche to its run task.
    expect(rows[0].fields.find((f) => f.header === "Research Task")?.value).toBe("SEA-293");
    expect(rows[1]).toMatchObject({ taxonomyId: "SF-002", shortName: "SF-002", sheetRow: 4 });
  });

  it("builds the same niche_context as the dashboard trigger", () => {
    const context = nicheContext([
      { header: "Domain", value: "Compliance" },
      { header: "Run Status", value: "Finished" },
      { header: "NAICS Code", value: "541611" },
      { header: "Who Buys", value: "" },
    ]);
    expect(context).toBe("Domain: Compliance\nNAICS Code: 541611");
  });
});

describe("searchfund scoring helpers", () => {
  it("ranks COMPLETE niches by decision score and leaves the rest unranked", () => {
    const ranked = rankScores([
      { id: "a", scoringStatus: "HOLD_GATES", decisionScore: 9 },
      { id: "b", scoringStatus: "COMPLETE", decisionScore: 5.2 },
      { id: "c", scoringStatus: "COMPLETE", decisionScore: 7.1 },
      { id: "d", scoringStatus: "COMPLETE", decisionScore: null },
    ]);
    expect(ranked.map((r) => [r.id, r.rank])).toEqual([["c", 1], ["b", 2], ["d", 3], ["a", null]]);
  });

  it("reads the run identifier from a Layer Data filename", () => {
    expect(issueFromFilename("Forced_Labour_Layer_Data_SEA-293.xlsx")).toBe("SEA-293");
    expect(issueFromFilename("report.xlsx")).toBeNull();
  });
});

describe("searchfund access", () => {
  const board = (overrides: Partial<Request["actor"]> = {}) =>
    ({ actor: { type: "board", source: "session", isInstanceAdmin: false, userEmail: "pat@example.com", ...overrides } }) as unknown as Request;

  it("lets every board user in when no allowlist is set", () => {
    expect(canViewSearchfund(board(), null)).toBe(true);
  });

  it("enforces the allowlist case-insensitively, but always admits instance admins", () => {
    const allow = readSearchfundConfig({ SEARCHFUND_ALLOWED_EMAILS: " Pat@Example.com , sam@example.com" }).allowedEmails;
    expect(canViewSearchfund(board(), allow)).toBe(true);
    expect(canViewSearchfund(board({ userEmail: "eve@example.com" }), allow)).toBe(false);
    expect(canViewSearchfund(board({ userEmail: "eve@example.com", isInstanceAdmin: true }), allow)).toBe(true);
  });

  it("never admits agents", () => {
    expect(canViewSearchfund({ actor: { type: "agent" } } as unknown as Request, null)).toBe(false);
  });

  it("compares ingest tokens safely", () => {
    expect(tokensMatch("secret-1", "secret-1")).toBe(true);
    expect(tokensMatch("secret-1", "secret-2")).toBe(false);
    expect(tokensMatch("secret-1", null)).toBe(false);
  });
});

describe("searchfund workbook mirror", () => {
  it("keeps every cell as text and drops only trailing blank rows and columns", () => {
    expect(normalizeSheetRows([
      ["Rank", "Subniche", 7.5, null, ""],
      ["", "", "", "", ""],
      [1, "Medical Peer Review", "", true, ""],
      ["", "", "", "", ""],
    ])).toEqual([
      ["Rank", "Subniche", "7.5", ""],
      ["", "", "", ""],
      ["1", "Medical Peer Review", "", "true"],
    ]);
    expect(normalizeSheetRows("nope")).toEqual([]);
  });
});

describe("searchfund composite score", () => {
  it("reads Scoring_Model weights and applies the sheet's linked formula", async () => {
    const { scoringModelWeights, compositeScore } = await import("../services/searchfund.js");
    const model = [
      ["Dimension", "Derivation", "Score 1 =", "Score 5 ="],
      ["1", "Fragmentation", "12%", "Auto"], ["2", "Labor", "12%", "x"], ["3", "AI", "15%", "x"], ["4", "Recurring", "13%", "x"],
      ["5", "PE", "13%", "x"], ["6", "Pricing", "12%", "x"], ["7", "Moat", "10%", "x"], ["8", "Succession", "7%", "x"],
      ["9", "Data", "6%", "x"], ["TOTAL", "100%"],
    ];
    const weights = scoringModelWeights(model)!.map((w) => w.weight);
    expect(weights).toEqual([0.12, 0.12, 0.15, 0.13, 0.13, 0.12, 0.1, 0.07, 0.06]);
    const fields = ["4", "5", "4", "5", "4", "4", "5", "4", "1"].map((value, i) => ({ header: `Score: D${i}`, value }));
    expect(compositeScore([{ header: "Taxonomy ID", value: "N1" }, ...fields], weights)).toBe("4.17");
    expect(compositeScore(fields.slice(1), weights)).toBeNull();
  });
});
