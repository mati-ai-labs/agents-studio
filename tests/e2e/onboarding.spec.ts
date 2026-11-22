import { test, expect } from "@playwright/test";

/**
 * E2E: Onboarding wizard flow.
 *
 * The wizard (ui/src/components/OnboardingWizard.tsx) is a four-step dialog:
 *   Step 1 — "Name your company" (+ the optional "Mission / goal" textarea)
 *   Step 2 — "Create your first agent" (agent name + adapter picker)
 *   Step 3 — "Give it something to do" (task title + description)
 *   Step 4 — "Ready to launch" → "Create & Open Issue"
 *
 * Filling the optional mission on step 1 creates the company *and* a
 * company-level goal (handleStep1Next → goalsApi.create with level
 * "company"), so this test drives step 1 → step 2 and verifies that both
 * records were persisted.
 *
 * The tail of the wizard (agent hire, task creation, launch) needs an adapter
 * and is covered by conference-room-typing-intro.spec.ts; surface-level
 * rendering of every step is snapshotted by nux-phase4-screenshots.spec.ts.
 */

const COMPANY_NAME = `E2E-Test-${Date.now()}`;
const MISSION = "Build affordable home robots that handle household chores.";

/**
 * Open the wizard.
 *
 * The /onboarding route renders a launcher card, but the app layout also
 * auto-opens the wizard when the instance has no companies yet — in that case
 * the wizard is already on screen and the launcher button sits behind the
 * full-screen wizard overlay, so it must not be clicked.
 */
async function openWizard(page: import("@playwright/test").Page) {
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

test.describe("Onboarding wizard", () => {
  // The wizard creates a company and its goal server-side — give the flow
  // more than the 60s default.
  test.setTimeout(120_000);

  test("create-company path: name + mission creates company and goal", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto("/onboarding");
    await openWizard(page);

    // Step 1 — Name your company.
    await page.getByPlaceholder("Acme Corp").fill(COMPANY_NAME);
    // The mission/goal field is optional; filling it is what creates the
    // company-level goal.
    await page
      .getByPlaceholder("What is this company trying to achieve?")
      .fill(MISSION);
    await page.getByRole("button", { name: /^Next/ }).click();

    // Step 2 — Create your first agent.
    await expect(
      page.getByRole("heading", { name: "Create your first agent" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('input[placeholder="CEO"]')).toHaveValue("CEO");

    // Verify the company + company-level goal were persisted.
    const baseUrl = page.url().split("/").slice(0, 3).join("/");
    const companiesRes = await page.request.get(`${baseUrl}/api/companies`);
    expect(companiesRes.ok()).toBe(true);
    const companies = await companiesRes.json();
    const company = companies.find(
      (c: { name: string }) => c.name === COMPANY_NAME,
    );
    expect(company, `company ${COMPANY_NAME} should exist`).toBeTruthy();

    const goalsRes = await page.request.get(
      `${baseUrl}/api/companies/${company.id}/goals`,
    );
    expect(goalsRes.ok()).toBe(true);
    const goals = await goalsRes.json();
    const companyGoal = (Array.isArray(goals) ? goals : []).find(
      (g: { level?: string }) => g.level === "company",
    );
    expect(companyGoal, "a company-level goal should be created").toBeTruthy();

    // The expanded wizard must not crash the app (Rules-of-Hooks regression).
    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
  });
});
