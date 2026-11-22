import { test, expect } from "@playwright/test";

/**
 * E2E: post-wizard onboarding launch.
 *
 * Completing the onboarding wizard creates the first assigned task and lands
 * the user on the newly created issue (ui/src/components/OnboardingWizard.tsx
 * → handleLaunch → navigate(`/${prefix}/issues/${issueRef}`)).
 *
 * The old Conference Room (BoardChat) intro surface this spec used to cover
 * is not part of the deployment baseline UI any more (removed by 43d81e50c
 * "fix: restore exact production UI source"), so the coverage now sits on the
 * wizard handoff that replaced it.
 */

const COMPANY_NAME = `E2E-TypingIntro-${Date.now()}`;
const FIRST_TASK_TITLE = `${COMPANY_NAME} Innovation Intelligence Report`;

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

test.describe("Issue launch after onboarding wizard", () => {
  // The wizard creates a company, an agent, a project and the starter issue
  // before it navigates — give the flow more than the 60s default.
  test.setTimeout(180_000);

  test("creates the first task and opens the issue", async ({
    page,
    baseURL,
  }) => {
    // Intercept env-test → instant pass (avoid running a real CLI check).
    await page.route("**/test-environment", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ status: "pass", checks: [] }),
      }),
    );

    // Intercept hire → perform a REAL hire server-side with an inert http
    // adapter so no real agent process spawns.
    await page.route("**/agent-hires", async (route) => {
      const req = route.request();
      const body = JSON.parse(req.postData() || "{}");
      const auth = req.headers().authorization;
      const real = await fetch(new URL(req.url(), baseURL).toString(), {
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

    await page.goto("/onboarding");
    await openWizard(page);

    // Step 1: company name.
    await page.getByPlaceholder("Acme Corp").fill(COMPANY_NAME);
    await page.getByRole("button", { name: /^Next/ }).click();

    // Step 2: agent (default name "CEO") → Next creates the agent.
    await expect(
      page.getByRole("heading", { name: "Create your first agent" }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /^Next/ }).click();

    // Step 3: the task title is prefilled with the company's starter task.
    await expect(
      page.getByRole("heading", { name: "Give it something to do" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator('input[placeholder="e.g. Research competitor pricing"]'),
    ).toHaveValue(FIRST_TASK_TITLE);
    await page.getByRole("button", { name: /^Next/ }).click();

    // Step 4: review → "Create & Open Issue" creates the task and opens it.
    await expect(
      page.getByRole("heading", { name: "Ready to launch" }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /Create & Open Issue/ }).click();

    await expect(page).toHaveURL(/\/issues\/[^/]+$/, { timeout: 60_000 });

    const companiesRes = await page.request.get("/api/companies");
    expect(companiesRes.ok()).toBe(true);
    const companies = await companiesRes.json();
    const company = companies.find((candidate: { name: string }) => candidate.name === COMPANY_NAME);
    expect(company).toBeTruthy();

    const issuesRes = await page.request.get(`/api/companies/${company.id}/issues`);
    expect(issuesRes.ok()).toBe(true);
    const issues = await issuesRes.json();
    const firstTask = issues.find((candidate: { title: string }) => candidate.title === FIRST_TASK_TITLE);
    expect(firstTask).toBeTruthy();
    await expect(page.getByText(FIRST_TASK_TITLE).first()).toBeVisible({ timeout: 15_000 });
  });
});
