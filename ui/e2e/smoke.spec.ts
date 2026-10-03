import { expect, test } from "@playwright/test";
import pkg from "../../package.json" with { type: "json" };

test("the dashboard opens and the main screens work", async ({ page }) => {
  // The UI must not call any host except the local Worker.
  const outside: string[] = [];

  await page.route("**/*", (route) => {
    const { hostname } = new URL(route.request().url());

    if (hostname === "localhost") return route.continue();

    outside.push(route.request().url());

    return route.abort();
  });

  const nav = page.getByRole("navigation", { name: "Main" });

  // The overview.
  await page.goto("/dashboard");
  await expect(page).toHaveTitle("Overview · fullsend");
  await expect(
    page.getByText("Your story starts with one email."),
  ).toBeVisible();

  // The emails list.
  await nav.getByRole("link", { name: "emails", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/emails$/);
  await expect(
    page.getByRole("heading", { name: "Emails", level: 1 }),
  ).toBeVisible();

  // The logs screen.
  await nav.getByRole("link", { name: "logs", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/logs$/);
  await expect(
    page.getByRole("heading", { name: "Logs", level: 1 }),
  ).toBeVisible();

  // A new webhook shows in the list.
  await nav.getByRole("link", { name: "webhooks", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Webhooks", level: 1 }),
  ).toBeVisible();
  await page.getByRole("button", { name: "add endpoint" }).first().click();

  const dialog = page.getByRole("dialog", { name: "Add endpoint" });

  await dialog.getByLabel("Endpoint URL").fill("https://example.com/hook");
  await dialog.getByRole("button", { name: "add endpoint" }).click();
  await page.getByRole("button", { name: "I saved it" }).click();
  await expect(page.getByText("https://example.com/hook")).toBeVisible();

  // The settings show the version.
  await nav.getByRole("link", { name: "settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Settings", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(pkg.version, { exact: true })).toBeVisible();

  expect(outside).toEqual([]);
});
