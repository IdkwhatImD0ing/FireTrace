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

  test("a verified account that is not allowlisted is rejected and gets no session", async ({
    page,
    context,
  }) => {
    await signIn(page, OUTSIDER);
    await expect(alerts(page)).toContainText("not in the dashboard allowlist");
    await expect(page).toHaveURL(/\/login$/);
    expect((await context.cookies()).some((c) => c.name === SESSION_COOKIE)).toBe(false);

    await page.goto("/projects");
    await expect(page).toHaveURL(/\/login$/);
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
