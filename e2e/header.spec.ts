import { expect, test } from "./fixtures";
import { gotoBoard } from "./board";

/**
 * The desktop board header keeps clear space between its groups.
 *
 * Only a real layout shows the overlap: the ask box pressed against the level
 * badge, or the points clipped by the right edge. The demo colony is not at
 * Lv 99, so the test writes the widest text the header can show (rank, "Max
 * level", the ask box's longest placeholder) into the page before measuring.
 */

const GAP = 24;
const SIDE_PADDING = 32;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoBoard(page);
  await page.evaluate(() => {
    const header = document.querySelector("header:not(.md\\:hidden)")!;
    header.querySelector("textarea")!.setAttribute("placeholder", "Answering… you can keep typing");
    const level = header.querySelector('[data-colony="level"]');
    if (level) level.textContent = "LV 99";
    for (const span of header.querySelectorAll("span")) {
      if (span.textContent?.startsWith("Colony ·")) span.textContent = "Colony · Queen";
      else if (/^\d+\/\d+$/.test(span.textContent ?? "")) span.textContent = "Max level";
    }
  });
});

async function measure(page: import("@playwright/test").Page) {
  const header = page.locator("header:visible").first();
  const box = async (l: import("@playwright/test").Locator) => (await l.first().boundingBox())!;
  const bar = await box(header);
  return {
    bar,
    logo: await box(header.getByTestId("formic-logo")),
    ask: await box(header.getByRole("textbox", { name: "Ask the PM" })),
    level: await box(header.locator('[data-colony="level"]')),
    points: await box(header.locator('[data-colony="score"]')),
    account: await box(header.getByRole("button", { name: /account|menu/i })),
  };
}

test("at 1280px the ask box keeps 24px from the level badge and nothing is clipped", async ({ page }) => {
  const m = await measure(page);
  expect(m.level.x - (m.ask.x + m.ask.width)).toBeGreaterThanOrEqual(GAP);
  expect(m.account.x + m.account.width).toBeLessThanOrEqual(m.bar.x + m.bar.width - SIDE_PADDING + 1);
  expect(m.points.x + m.points.width).toBeLessThanOrEqual(m.account.x);
});

for (const width of [1440, 1920]) {
  test(`at ${width}px the ask box is centred at full width and the header is 64px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const m = await measure(page);
    expect(m.bar.height).toBe(64);
    expect(m.ask.width).toBeGreaterThan(500);
    expect(m.ask.x + m.ask.width / 2).toBeCloseTo(width / 2, 0);
    expect(m.logo.x).toBeGreaterThanOrEqual(SIDE_PADDING);
    expect(m.account.x + m.account.width).toBeLessThanOrEqual(width - SIDE_PADDING + 1);
  });
}

test("between 900px and 768px the ask box narrows and no two items touch", async ({ page }) => {
  let last = Infinity;
  for (let width = 900; width >= 768; width -= 16) {
    await page.setViewportSize({ width, height: 800 });
    const m = await measure(page);
    expect(m.ask.width).toBeLessThanOrEqual(last);
    last = m.ask.width;
    const row = [m.logo, m.ask, m.level, m.points, m.account];
    row.slice(1).forEach((item, i) => {
      const before = row[i]!;
      expect(item.x, `${width}px item ${i + 1}`).toBeGreaterThan(before.x + before.width);
    });
    expect(m.account.x + m.account.width).toBeLessThanOrEqual(width - SIDE_PADDING + 1);
  }
});
