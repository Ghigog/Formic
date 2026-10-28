import { expect, test, type Page } from "@playwright/test";
import { card, column, columnOf, gotoBoard, idForKey, moveViaApi } from "./board";

/**
 * The board below 768px, where drag is replaced by an explicit action.
 *
 * The narrow widths are asserted rather than assumed: a 375px phone with a
 * horizontal scrollbar is the failure this layout exists to avoid, and it is
 * invisible at any wider viewport.
 */

test.use({ hasTouch: true });

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

/** One real touch swipe across the board, by dx pixels, over CDP. */
async function swipe(page: Page, dx: number) {
  const cdp = await page.context().newCDPSession(page);
  const box = (await page.locator("main").boundingBox())!;
  const y = box.y + 40;
  const x0 = box.x + box.width / 2;
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x, y }],
    });
  await touch("touchStart", x0);
  for (const step of [0.25, 0.5, 0.75, 1]) await touch("touchMove", x0 + dx * step);
  await touch("touchEnd", x0 + dx);
}

test("a swipe moves from Backlog to To Do", async ({ page }) => {
  await expect(column(page, "Backlog")).toBeVisible();
  await expect(page.getByRole("list", { name: "Columns" }).getByRole("button")).toHaveCount(5);

  await swipe(page, -150);

  await expect(column(page, "To Do")).toBeVisible();
  await expect(column(page, "Backlog")).toHaveCount(0);
});

test("there is no floating Advance button", async ({ page }) => {
  await expect(page.getByRole("button", { name: /^Advance/ })).toHaveCount(0);
});

/*
 * The card is taken from the arrow's own accessible name rather than from
 * the top of the column: the test holds the button to what it says.
 */
test("a card's arrow moves the card it names", async ({ page }) => {
  const arrow = page.getByRole("button", { name: /^Move \S+ to To Do$/ }).first();
  const label = await arrow.getAttribute("aria-label");

  const named = label?.match(/^Move (\S+) to To Do$/);
  expect(named, `unexpected arrow label: ${label}`).not.toBeNull();

  const cardId = await idForKey(page, named![1]!);
  expect(await columnOf(page, cardId)).toBe("Backlog");

  await arrow.click();

  // One column renders at a time here, so the card leaves the DOM when it
  // moves. Follow it to the tab it landed on, as a user does.
  await expect(card(page, cardId)).toHaveCount(0);
  await swipe(page, -150);
  await expect(card(page, cardId)).toBeVisible();

  // Put the board back.
  await moveViaApi(page, cardId, ["To Do", "Backlog"]);
  await swipe(page, 150);
  expect(await columnOf(page, cardId)).toBe("Backlog");
});

test("the app bar at 375px has heat and a timeline button, and no + button", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });

  await expect(page.getByRole("button", { name: "New backlog item" })).toHaveCount(0);
  await expect(page.locator('header:visible [data-colony="heat"]')).toBeVisible();

  await page.getByRole("button", { name: "Open timeline" }).click();
  await expect(page.getByRole("button", { name: "Back to board" })).toBeVisible();
});

test("the colony bar stays pinned to the bottom of the phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  const footer = page.locator("footer[data-colony-mask]");
  const bottom = async () => (await footer.boundingBox())!.y + (await footer.boundingBox())!.height;

  expect(await bottom()).toBeCloseTo(700, 0);

  await page.mouse.move(195, 300);
  await page.mouse.wheel(0, 2000);
  await page.evaluate(() => window.scrollTo(0, 2000));
  expect(await bottom()).toBeCloseTo(700, 0);
});

test("the sentinel Re-audit label stays on one line at 390px", async ({ page }) => {
  // Calibrating and auditing can each take up to 15s on a slow runner, which
  // leaves too little of the default 30s for the check itself.
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.getByRole("button", { name: /Audit grade/ }).click();
  const card = page.getByRole("region", { name: "Sentinels" }).getByRole("listitem", { name: /Professor O'Chumley/ });
  // The store is shared across the run, so an earlier test may already have
  // calibrated or audited this sentinel; take it only as far as it needs.
  if (await card.getByRole("button", { name: "Calibrate" }).isVisible()) {
    await card.getByRole("button", { name: "Calibrate" }).click();
    await expect(card.getByRole("button", { name: "Audit", exact: true })).toBeVisible({ timeout: 15_000 });
  }
  if (await card.getByRole("button", { name: "Audit", exact: true }).isVisible()) {
    await card.getByRole("button", { name: "Audit", exact: true }).click();
  }
  await expect(card).toHaveAccessibleName(/4 of 5 stars/, { timeout: 15_000 });
  await card.click();

  const button = page.getByRole("dialog").getByRole("button", { name: "Re-audit" }).first();
  const lineHeight = await button.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 0);
  const label = await button.evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    return r.getBoundingClientRect().height;
  });
  expect(lineHeight).toBeGreaterThan(0);
  expect(label).toBeLessThanOrEqual(lineHeight + 1);
});
