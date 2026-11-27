import { describe, expect, it } from "vitest";
import { DASHBOARD_SDK, handleBridgeOp, withDashboardSdk } from "./dashboard-bridge";

describe("dashboard bridge", () => {
  it("injects the SDK before the page's own scripts", () => {
    const html = withDashboardSdk('<!doctype html><html><head><script src="app.js"></script></head><body></body></html>');
    expect(html.indexOf(DASHBOARD_SDK)).toBeLessThan(html.indexOf("app.js"));
    expect(withDashboardSdk("<div>hi</div>").startsWith(DASHBOARD_SDK)).toBe(true);
    expect(withDashboardSdk("<html><body></body></html>")).toContain(`<head>${DASHBOARD_SDK}</head>`);
  });

  it("refuses routines the dashboard was not allowed to run", async () => {
    const ctx = {
      companyId: "c1",
      dashboard: { id: "d1", name: "D", slug: "d", allowedRoutineIds: ["r-ok"] },
      version: 1,
      viewer: { name: null, email: null },
      openIssue: () => {},
    };
    await expect(handleBridgeOp(ctx, "runRoutine", { routineId: "r-evil" })).rejects.toThrow(/not allowed/);
    await expect(handleBridgeOp(ctx, "nope", {})).rejects.toThrow(/Unknown/);
    await expect(handleBridgeOp(ctx, "info", {})).resolves.toMatchObject({ dashboard: { id: "d1", version: 1 } });
  });
});
