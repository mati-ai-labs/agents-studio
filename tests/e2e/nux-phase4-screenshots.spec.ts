import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * NUX Phase 4 — visual QA screenshot capture.
 *
 * Boots a throwaway local_trusted instance (see playwright.config.ts webServer)
 * and captures screenshots of every onboarding surface that ships in the
 * deployment baseline UI:
 *   - "Name your company" (company name + mission/goal)
 *   - "Create your first agent" (adapter picker)
 *   - "Give it something to do" (task title + description)
 *   - "Ready to launch" review + the issue the launch opens
 *
 * The remaining NUX surfaces this spec used to capture (the onboarding front
 * door / "Build a new company" path picker, the "Add agents to your org"
 * growth intake, the Conference Room / BoardChat shell and the Artifacts
 * page) are not part of the deployment baseline UI any more — commit
 * 43d81e50c "fix: restore exact production UI source" (merged through PR #10
 * "codex/restore-exact-production-ui") replaced them with the four-step
 * wizard in ui/src/components/OnboardingWizard.tsx. Tracked by LCH-534.
 *
 * These are structural/rendering checks — LLM-dependent streaming (CEO chat
 * responses, hiring-plan generation) is verified separately on an LLM-backed
 * instance. Screenshots land in ./nux-phase4-shots for upload as evidence.
 */

// Write under the gitignored test-results dir so re-runs leave no untracked
// noise; screenshots are uploaded to the issue as QA evidence, not committed.
const SHOT_DIR = path.join(__dirname, "test-results", "nux-phase4-shots");

function shot(name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  return path.join(SHOT_DIR, name);
}

/**
 * Open the wizard.
 *
 * The /onboarding route renders a launcher card, but the app layout also
 * auto-opens the wizard when the instance has no companies yet — in that case
 * the wizard is already on screen and the launcher button sits behind the
 * full-screen wizard overlay, so it must not be clicked.
 */
async function openWizard(page: import("@playwright/test").Page) {
  await page.goto("/onboarding");
  const step1Heading = page.getByRole("heading", { name: "Name your company" });
  if ((await step1Heading.count()) === 0) {
    const launcher = page.getByRole("button", {
      name: /Start Onboarding|New Company|Add Agent/,
    });
    if (await launcher.count()) {
      // A click that lands on the already-open wizard overlay is harmless.
      await launcher.first().click({ timeout: 10_000 }).catch(() => undefined);
    }
  }
  await expect(step1Heading).toBeVisible({ timeout: 15_000 });
}

test.describe("NUX Phase 4 visual QA", () => {
  // The wizard creates a company, an agent, a project and the starter issue
  // before it navigates — give the capture more than the 60s default.
  test.setTimeout(180_000);

  test("captures every integrated surface", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push("PAGEERROR: " + err.message));

    const baseUrl =
      "http://127.0.0.1:" + (process.env.PAPERCLIP_E2E_PORT ?? "3199");

    // The adapter probe would shell out to a real CLI — stub it out so the
    // capture stays deterministic in CI.
    await page.route("**/test-environment", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ status: "pass", checks: [] }),
      }),
    );
    await page.route("**/agent-hires", async (route) => {
      const req = route.request();
      const body = JSON.parse(req.postData() || "{}");
      const auth = req.headers().authorization;
      const real = await fetch(new URL(req.url(), baseUrl).toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(auth ? { Authorization: auth } : {}),
        },
        body: JSON.stringify({
          name: body.name,
          role: body.role,
          adapterType: "http",
          adapterConfig: { url: "http://127.0.0.1:1/dead" },
          runtimeConfig: { heartbeat: { enabled: false } },
        }),
      });
      await route.fulfill({
        status: real.status,
        contentType: "application/json",
        body: await real.text(),
      });
    });

    // ── Section A: the four onboarding steps ───────────────────────────────
    await openWizard(page);

    await expect(
      page.getByRole("heading", { name: "Name your company" }),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByPlaceholder("Acme Corp").fill("QA Robotics");
    await page
      .getByPlaceholder("What is this company trying to achieve?")
      .fill("Build affordable home robots that handle household chores.");
    await page.screenshot({ path: shot("02-create-name.png") });

    await page.getByRole("button", { name: /^Next/ }).click();
    await expect(
      page.getByRole("heading", { name: "Create your first agent" }),
    ).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: shot("03-create-agent.png") });

    await page.getByRole("button", { name: /^Next/ }).click();
    await expect(
      page.getByRole("heading", { name: "Give it something to do" }),
    ).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: shot("04-create-task.png") });

    await page.getByRole("button", { name: /^Next/ }).click();
    await expect(
      page.getByRole("heading", { name: "Ready to launch" }),
    ).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: shot("05-launch-review.png") });

    await page.getByRole("button", { name: /Create & Open Issue/ }).click();
    await expect(page).toHaveURL(/\/issues\/[^/]+$/, { timeout: 60_000 });
    await page.waitForTimeout(1_000);
    await page.screenshot({ path: shot("06-issue-detail.png") });

    // The wizard should have created the company it named.
    const companiesRes = await page.request.get(`${baseUrl}/api/companies`);
    expect(companiesRes.ok()).toBe(true);
    const companies = await companiesRes.json();
    const qaCompany = (Array.isArray(companies) ? companies : []).find(
      (c: { name: string }) => c.name === "QA Robotics",
    );
    expect(qaCompany, "wizard should have created QA Robotics").toBeTruthy();

    for (const f of [
      "02-create-name.png",
      "03-create-agent.png",
      "04-create-task.png",
      "05-launch-review.png",
      "06-issue-detail.png",
    ]) {
      const p = shot(f);
      expect(fs.existsSync(p), `missing ${f}`).toBe(true);
      expect(fs.statSync(p).size, `empty ${f}`).toBeGreaterThan(1_000);
    }

    // No React Rules-of-Hooks / render crashes on any surface we visited.
    const hookErrors = consoleErrors.filter(
      (e) => /Rendered more hooks|change in the order of Hooks/i.test(e),
    );
    expect(hookErrors, hookErrors.join("\n")).toHaveLength(0);
  });
});
