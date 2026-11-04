import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS_OUTBOX } from "../playwright.config";

/**
 * Accounts mode with email sign-in and no GitHub App: what a new person
 * meets, from the login page to a board, with only an email address.
 * The console mailer writes each email to ACCOUNTS_OUTBOX (playwright.config.ts).
 */

async function linkFor(email: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const lines = (await readFile(ACCOUNTS_OUTBOX, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
    const mail = lines.map((l) => JSON.parse(l) as { to: string; link: string }).reverse().find((m) => m.to === email);
    if (mail) return mail.link;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no sign-in email for ${email}`);
}

async function signIn(page: Page, email: string) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("link", { name: /Sign in with GitHub/ })).toHaveCount(0);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("status")).toContainText("Check your inbox");

  await page.goto(await linkFor(email));
  await page.getByRole("button", { name: "Sign in to Formic" }).click();

  await expect(page).toHaveURL(/\/legal/);
  await page.getByRole("button", { name: "Accept and continue" }).click();
}

// Serial, one server: the first person to sign in is whoever set it up.
test("the first person to sign in by email gets the boards from before accounts", async ({ page }) => {
  await signIn(page, `owner-${Date.now()}@example.com`);
  await expect(page.getByRole("region", { name: "Backlog" })).toBeVisible();
});

test("a new person signs in with only an email and starts a board of their own", async ({ page }) => {
  const email = `ana-${Date.now()}@example.com`;
  await signIn(page, email);

  // No GitHub on this deployment: the welcome leads with a board of its own.
  await expect(page.getByRole("heading", { name: "Start a board" })).toBeVisible();
  await expect(page.getByText("GitHub isn't set up on this Formic")).toBeVisible();
  await page.getByRole("button", { name: "Start without a repository" }).click();
  await expect(page.getByRole("region", { name: "Backlog" })).toBeVisible();

  await page.goto("/settings");
  await expect(page.getByText(`Signed in as ${email}.`)).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
});

test("a sign-in link works once", async ({ page }) => {
  const email = `bo-${Date.now()}@example.com`;
  await signIn(page, email);
  const link = await linkFor(email);

  await page.context().clearCookies();
  await page.goto(link);
  await page.getByRole("button", { name: "Sign in to Formic" }).click();
  await expect(page).toHaveURL(/\/login\?error=/);
  await expect(page.getByText("That sign-in link has expired or was already used")).toBeVisible();
});

test("opening a link without clicking spends nothing", async ({ page, request }) => {
  const email = `cy-${Date.now()}@example.com`;
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  const link = await linkFor(email);

  // A mail scanner fetching the link.
  expect((await request.get(link)).ok()).toBe(true);

  await page.goto(link);
  await page.getByRole("button", { name: "Sign in to Formic" }).click();
  await expect(page).toHaveURL(/\/legal/);
});
