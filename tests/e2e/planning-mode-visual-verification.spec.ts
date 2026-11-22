import { expect, test } from "@playwright/test";

const AGENT_NAME = "CEO";

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

test("captures planning mode UI for desktop and mobile", async ({ page }) => {
  // The wizard creates a company, an agent, a project and the starter issue
  // before it navigates — give the flow more than the 60s default.
  test.setTimeout(180_000);
  const timestamp = Date.now();
  const companyName = `PAP-3413-${timestamp}`;
  const taskTitle = `${companyName} Innovation Intelligence Report`;
  const screenshotDir = "test-results/planning-mode";

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
    const real = await fetch(new URL(req.url(), page.url()).toString(), {
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

  await page.locator('input[placeholder="Acme Corp"]').fill(companyName);
  await page.getByRole("button", { name: /^Next/ }).click();

  await expect(page.getByRole("heading", { name: "Create your first agent" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('input[placeholder="CEO"]')).toHaveValue(AGENT_NAME);
  await page.getByRole("button", { name: /^Next/ }).click();

  await expect(page.getByRole("heading", { name: "Give it something to do" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /^Next/ }).click();

  await expect(page.getByRole("heading", { name: "Ready to launch" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /Create & Open Issue/ }).click();
  await expect(page).toHaveURL(/\/issues\/[^/]+$/, { timeout: 60_000 });

  const baseOrigin = new URL(page.url()).origin;
  const companyRes = await page.request.get(`${baseOrigin}/api/companies`);
  expect(companyRes.ok()).toBe(true);
  const companies = await companyRes.json();
  const company = companies.find((c: { name: string }) => c.name === companyName);
  expect(company).toBeTruthy();
  const issueRes = await page.request.get(`${baseOrigin}/api/companies/${company.id}/issues`);
  expect(issueRes.ok()).toBe(true);
  const issues = await issueRes.json();
  const planningSeedIssue = issues.find(
    (candidate: { id: string; identifier?: string; title: string }) =>
      candidate.title === taskTitle,
  );
  expect(planningSeedIssue).toBeTruthy();

  const issue = planningSeedIssue;
  const issueIdentifier = issue.identifier ?? issue.id;
  const issuePath = `/${company.issuePrefix ?? company.id}/issues/${issueIdentifier}`;
  const companyPrefix = company.issuePrefix ?? company.id;
  const issueLinkSelector = `a[href$="/issues/${issueIdentifier}"]`;

  const setMode = async (mode: "standard" | "planning") => {
    const patchRes = await page.request.patch(`${baseOrigin}/api/issues/${issue.id}`, {
      data: { workMode: mode },
    });
    expect(patchRes.ok()).toBe(true);
    await expect
      .poll(async () => {
        const currentRes = await page.request.get(`${baseOrigin}/api/issues/${issue.id}`);
        expect(currentRes.ok()).toBe(true);
        const current = await currentRes.json();
        return current.workMode;
      }, { timeout: 10_000 })
      .toBe(mode);
  };

  await setMode("planning");

  await page.goto(issuePath);
  // The planning badge on the issue header reads "Planning".
  await expect(page.getByText("Planning").first()).toBeVisible();
  await expect(page.getByTestId("issue-chat-composer")).toHaveAttribute("data-pending-work-mode", "planning");
  const desktopPlanningToggle = page.getByTestId("issue-chat-composer-work-mode-toggle");
  await expect(desktopPlanningToggle).toBeVisible();
  await expect(desktopPlanningToggle).toHaveAttribute("data-pending-work-mode", "planning");
  await expect(desktopPlanningToggle).toHaveAttribute("aria-pressed", "true");

  await page.screenshot({
    path: `${screenshotDir}/desktop-planning-detail-${timestamp}.png`,
    fullPage: true,
  });

  await page.goto(`/${companyPrefix}/issues`);
  await expect(page.locator(issueLinkSelector)).toBeVisible();
  // The issues list row carries the same "Planning" indicator.
  await expect(page.locator(issueLinkSelector)).toContainText("Planning");
  await page.screenshot({
    path: `${screenshotDir}/desktop-planning-row-${timestamp}.png`,
    fullPage: true,
  });

  await page.goto(issuePath);
  // The planning chip switches the pending submission back to standard mode;
  // it only renders while planning is on.
  await page.getByTestId("issue-chat-composer-work-mode-toggle").click();
  await expect(page.getByTestId("issue-chat-composer")).toHaveAttribute("data-pending-work-mode", "standard");
  await expect(page.getByTestId("issue-chat-composer-work-mode-toggle")).toHaveCount(0);
  await page.screenshot({
    path: `${screenshotDir}/desktop-standard-toggle-${timestamp}.png`,
    fullPage: true,
  });

  await setMode("planning");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(issuePath);
  await expect(page.getByText("Planning").first()).toBeVisible();
  const mobilePlanningToggle = page.getByTestId("issue-chat-composer-work-mode-toggle");
  await expect(mobilePlanningToggle).toBeVisible();
  await expect(mobilePlanningToggle).toHaveAttribute("data-pending-work-mode", "planning");
  await expect(mobilePlanningToggle).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({
    path: `${screenshotDir}/mobile-planning-detail-${timestamp}.png`,
    fullPage: true,
  });

  await page.goto(`/${companyPrefix}/issues`);
  await expect(page.locator(issueLinkSelector)).toBeVisible();
  await expect(page.locator(issueLinkSelector)).toContainText("Planning");
  await page.screenshot({
    path: `${screenshotDir}/mobile-planning-row-${timestamp}.png`,
    fullPage: true,
  });
});
