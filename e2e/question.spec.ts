import { expect, test } from "./fixtures";
import { card, gotoBoard } from "./board";

/**
 * A card an agent is waiting on shows as a plum "Question" (never a red
 * warning), at phone width. The demo board seeds one Epic and one ticket with
 * a question, a ticket that needs authorization and a failed one
 * (src/lib/fixtures/board.ts).
 */

test.use({ hasTouch: true, viewport: { width: 390, height: 800 } });

test.beforeEach(async ({ page }) => {
  await gotoBoard(page);
  await page.getByRole("list", { name: "Columns" }).getByRole("button", { name: /^To Do/ }).click();
});

test("an Epic's question opens as a plum banner with the questions and their reasons", async ({ page }) => {
  await page.locator('[data-tid="epic-5"] h3 button').first().click();
  const dialog = page.getByRole("dialog", { name: "Epic detail" });
  const banner = dialog.locator('[role="alert"][data-severity="question"]');

  await expect(banner).toBeVisible();
  await expect(banner.getByRole("img", { name: "Question" })).toBeVisible();
  await expect(banner).toContainText("Question");
  await expect(banner).toContainText("Should the digest go out weekly or daily?");

  await banner.getByRole("button").first().click();
  await expect(banner).toContainText("Who receives it: every member or only owners?");
  await expect(banner).toContainText("Why: It sets how often the job runs");
  await expect(banner).toContainText("Why: Members need an unsubscribe link");

  // Not a warning: no red "!" anywhere, and nothing pulses.
  // (Scoped to the drawer: the failed card on the board behind it is meant to be red.)
  await expect(dialog.getByRole("img", { name: /^(Warning|Needs you)/ })).toHaveCount(0);
  await expect(dialog.getByText("!", { exact: true })).toHaveCount(0);
  const looping = await banner.evaluate(
    (el) =>
      el.getAnimations({ subtree: true }).filter((a) => a.effect?.getComputedTiming().iterations === Infinity).length,
  );
  expect(looping).toBe(0);
});

test("a ticket with a question reads Question: plum notice and badge on the board, plum dot on its chip", async ({ page }) => {
  const ticket = card(page, "prot-9");
  await expect(ticket).toBeVisible();

  const notice = ticket.getByTestId("card-notice");
  await expect(notice).toHaveAttribute("data-severity", "question");
  await expect(notice.getByRole("img", { name: "Question" })).toBeVisible();
  await expect(notice).toContainText("Should exports be CSV or JSON?");

  await expect(ticket.getByRole("img", { name: /^Question: / })).toBeVisible();
  await expect(ticket.getByRole("img", { name: /^Needs you/ })).toHaveCount(0);

  // The chip is the status pill in the ticket's own drawer.
  await ticket.click();
  const chip = page
    .getByRole("dialog", { name: "Ticket detail" })
    .locator("span", { hasText: /^Question$/ })
    .filter({ has: page.locator("span.bg-plum") });
  await expect(chip).toBeVisible();
});

test("a ticket that needs authorization stays yellow and a failed one stays red", async ({ page }) => {
  const needs = card(page, "prot-10").getByTestId("card-notice");
  await expect(needs).toHaveAttribute("data-severity", "alert");
  await expect(needs).toContainText("Needs authorization");

  const failed = card(page, "prot-11").getByTestId("card-notice");
  await expect(failed).toHaveAttribute("data-severity", "warning");
  await expect(failed).toContainText("Failed");
});
