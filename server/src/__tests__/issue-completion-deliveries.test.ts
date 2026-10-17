import { describe, expect, it } from "vitest";
import { completedAtMatches } from "../services/issue-completion-deliveries.js";

describe("completedAtMatches", () => {
  it("matches a raw SQL timestamp string against the issue's Date", () => {
    expect(completedAtMatches("2026-10-17 06:55:44.424+00", new Date("2026-10-17T06:55:44.424Z"))).toBe(true);
  });

  it("matches two Dates and two strings", () => {
    expect(completedAtMatches(new Date("2026-10-17T06:55:44.424Z"), new Date("2026-10-17T06:55:44.424Z"))).toBe(true);
    expect(completedAtMatches("2026-10-17T06:55:44.424Z", "2026-10-17 06:55:44.424+00")).toBe(true);
  });

  it("rejects a different completion time", () => {
    expect(completedAtMatches("2026-10-17 06:55:44.424+00", new Date("2026-10-17T07:00:00.000Z"))).toBe(false);
  });

  it("handles nulls", () => {
    expect(completedAtMatches(null, null)).toBe(true);
    expect(completedAtMatches(null, new Date())).toBe(false);
    expect(completedAtMatches("2026-10-17 06:55:44.424+00", null)).toBe(false);
  });
});
