import { expect, test } from "@playwright/test";

/** The public documentation pages need no session and render the committed Markdown. */
test.describe("documentation pages", () => {
  test("the index lists every guide with working links", async ({ page }) => {
    const res = await page.goto("/docs");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Run FireTrace");
    const nav = page.getByRole("navigation", { name: "Documentation" });
    await expect(nav.getByRole("link", { name: "API", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "MCP", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Deploy with an AI agent" })).toBeVisible();
    await expect(page.getByRole("link", { name: "/api/v1/openapi.json" })).toBeVisible();
  });

  test("a reference page renders headings with anchors, tables, code with copy buttons, and rewritten links", async ({
    page,
  }) => {
    const res = await page.goto("/docs/api");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "FireTrace API" })).toBeVisible();
    await expect(page.locator("h2#api-keys-and-scopes")).toBeVisible();
    await expect(page.locator(".doc-table table").first()).toBeVisible();
    await expect(
      page.locator(".doc-code").first().getByRole("button", { name: "Copy" }),
    ).toBeVisible();
    // Sibling docs are linked as routes, not as .md files.
    const mcpLink = page.locator("article a[href='/docs/mcp']").first();
    await expect(mcpLink).toBeVisible();
    // Only the GitHub "edit this page" link may point at a .md file.
    expect(await page.locator("article a[href$='.md']:not([href*='github.com'])").count()).toBe(0);
    await expect(
      page
        .getByRole("navigation", { name: "Documentation" })
        .getByRole("link", { name: "API", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("complementary", { name: "On this page" })).toContainText(
      "Endpoints",
    );
  });

  test("the setup guide renders numbered steps with code blocks inside them", async ({ page }) => {
    await page.goto("/docs/firebase-setup");
    await expect(
      page.getByRole("heading", { level: 2, name: /Authorized domains/ }),
    ).toHaveAttribute("id", "5-authorized-domains");
    const step = page.locator("article ol li").filter({ hasText: "Send the example trace" });
    await expect(step.locator(".doc-code")).toHaveCount(1);
    await expect(
      page.locator("article").getByText("cannot be changed after creation"),
    ).toBeVisible();
  });

  test("the agent prompt page shows the full prompt in one copyable block", async ({ page }) => {
    await page.goto("/docs/deploy-prompt");
    const block = page.locator(".doc-code").first();
    await expect(block).toContainText("Deploy FireTrace for me.");
    await expect(block).toContainText("13. Finish.");
    await expect(block.getByRole("button", { name: "Copy" })).toBeVisible();
  });

  test("unknown docs are 404s and the landing page links to the docs", async ({ page }) => {
    const res = await page.goto("/docs/not-a-doc");
    expect(res?.status()).toBe(404);
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Docs" })).toHaveAttribute("href", "/docs");
  });
});
