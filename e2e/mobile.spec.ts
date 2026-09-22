import { expect, test } from "@playwright/test";
import { card, column, columnOf, gotoBoard, idForKey, moveViaApi } from "./board";

/**
 * The board below 768px, where drag is replaced by an explicit action.
 *
 * The narrow widths are asserted rather than assumed: a 375px phone with a
 * horizontal scrollbar is the failure this layout exists to avoid, and it is
 * invisible at any wider viewport.
 */

test.beforeEach(async ({ page }) => {
  await gotoBoard(page);
});

for (const width of [390, 375, 320]) {
  test(`does not scroll sideways at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));

    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
}

test("the tab bar reaches every column, one at a time", async ({ page }) => {
  await expect(column(page, "Backlog")).toBeVisible();
  await expect(column(page, "In Review")).toHaveCount(0);

  await page.getByRole("button", { name: /^In Review/ }).click();

  await expect(column(page, "In Review")).toBeVisible();
  await expect(column(page, "Backlog")).toHaveCount(0);
});

test("every tap target clears 44px", async ({ page }) => {
  const targets = page.locator("nav[aria-label='Columns'] button");
  const count = await targets.count();
  expect(count).toBe(5);

  for (let i = 0; i < count; i++) {
    const box = await targets.nth(i).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
});

/*
 * The card is taken from the button's own accessible name rather than from
 * the top of the column. The point of naming the card is that the action is
 * unambiguous, so the test should hold the button to what it says, not to
 * what the test guessed it meant.
 */
test("the advance action moves the card it names", async ({ page }) => {
  const advance = page.getByRole("button", { name: /^Advance/ });
  const label = await advance.getAttribute("aria-label");

  const named = label?.match(/^Advance (\S+) to To Do$/);
  expect(named, `unexpected advance label: ${label}`).not.toBeNull();

  const cardId = await idForKey(page, named![1]!);
  expect(await columnOf(page, cardId)).toBe("Backlog");

  await advance.click();

  // One column renders at a time here, so the card leaves the DOM when it
  // moves. Follow it to the tab it landed on rather than looking for it in
  // place — which is also what a user does.
  await expect(card(page, cardId)).toHaveCount(0);
  await page.getByRole("button", { name: /^To Do/ }).click();
  await expect(card(page, cardId)).toBeVisible();

  // Put the board back. The advance action only goes forward, so the undo
  // goes through the API.
  await moveViaApi(page, cardId, ["To Do", "Backlog"]);
  await page.getByRole("button", { name: /^Backlog/ }).click();
  expect(await columnOf(page, cardId)).toBe("Backlog");
});
