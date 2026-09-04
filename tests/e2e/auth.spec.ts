import { expect, test } from "@playwright/test";
import { OUTSIDER, OWNER } from "./accounts";
import { alerts, SESSION_COOKIE, signIn } from "./helpers";

test.describe("dashboard sign-in through the Auth emulator", () => {
  test("an allowlisted owner signs in with email and password and lands on /projects", async ({
    page,
    context,
  }) => {
    await signIn(page, OWNER);
    await page.waitForURL(/\/projects$/);
    await expect(page.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible();
    await expect(page.getByText(OWNER.email)).toBeVisible();

    const session = (await context.cookies()).find((c) => c.name === SESSION_COOKIE);
    expect(session).toBeDefined();
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe("Lax");

    // A signed-in owner is bounced from the login page back to the dashboard.
    await page.goto("/login");
    await page.waitForURL(/\/projects$/);
  });

  test("a verified account outside the allowlist is admitted as a trial user (trial mode is on for the e2e server; the rejection path is covered by tests/integration/session.test.ts)", async ({
    page,
    context,
  }) => {
    // The e2e server runs with FIRETRACE_TRIAL_TRACE_LIMIT=5, so a verified
    // account outside the allowlist is admitted as a capped trial user.
    await signIn(page, OUTSIDER);
    await page.waitForURL(/\/projects$/);
    await expect(page.getByText("trial", { exact: true })).toBeVisible();
    await expect(page.getByTestId("trial-status")).toContainText("0 of 5 traces used");
    expect((await context.cookies()).some((c) => c.name === SESSION_COOKIE)).toBe(true);
  });

  test("the public headers offer sign-in only while there is no session", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('header a[href="/login"]')).toHaveText("Sign in");
    await expect(page.getByTestId("trial-invite")).toBeVisible();
    await page.goto("/docs");
    await expect(page.locator('header a[href="/login"]')).toHaveText("Sign in");

    await signIn(page, OWNER);
    await page.waitForURL(/\/projects$/);

    await page.goto("/");
    await expect(page.locator('header a[href="/projects"]')).toHaveText("Projects");
    await expect(page.locator('header a[href="/login"]')).toHaveCount(0);
    await expect(page.getByTestId("trial-invite")).toHaveCount(0);
    await page.goto("/docs");
    await expect(page.locator('header a[href="/projects"]')).toHaveText("Projects");
    await expect(page.locator('header a[href="/login"]')).toHaveCount(0);
  });

  test("a wrong password is rejected and gets no session", async ({ page, context }) => {
    await signIn(page, { email: OWNER.email, password: "definitely-not-the-password" });
    await expect(alerts(page)).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    expect((await context.cookies()).some((c) => c.name === SESSION_COOKIE)).toBe(false);
  });

  test("signing out clears the session", async ({ page, context }) => {
    await signIn(page, OWNER);
    await page.waitForURL(/\/projects$/);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(/\/login$/);
    expect((await context.cookies()).some((c) => c.name === SESSION_COOKIE)).toBe(false);
    await page.goto("/projects");
    await expect(page).toHaveURL(/\/login$/);
  });
});
