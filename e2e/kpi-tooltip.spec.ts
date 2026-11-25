import { expect, test } from "./fixtures";
import { gotoBoard } from "./board";

/**
 * The KPI tooltip at the edges of a chart on a 390px phone.
 *
 * The card is wider than the room beside the first or last mark, so it has to
 * be pulled back inside the figure. Only a real layout shows that.
 *
 * The KPIs open at level 20, so the test turns on "unlock everything" for the
 * board and answers /api/kpi with a fixed 14-day throughput.
 */

const DAYS = 14;

test.use({ viewport: { width: 390, height: 800 }, hasTouch: true });

test("the tooltip stays inside the figure at the first and last marks", async ({ page }) => {
  const throughput = Array.from({ length: DAYS }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    done: 1 + (i % 4),
  }));
  await page.route("**/api/kpi?*", (route) =>
    route.fulfill({
      json: {
        window: "30d",
        tiles: { done: 20, inFlight: 2, cycleTimeDays: 2, passRate: 0.8, precision: 0.9 },
        timeInColumn: { backlog: null, todo: null, in_progress: null, in_review: null },
        throughput,
        cycleTime: [],
        quality: [],
      },
    }),
  );

  const { active } = (await (await page.request.get("/api/projects")).json()) as { active: { id: string } };
  const patched = await page.request.patch(`/api/projects/${active.id}`, { data: { unlockAllSentinels: true } });
  expect(patched.ok()).toBe(true);

  try {
    await gotoBoard(page);
    await page.getByRole("button", { name: "Open timeline" }).click();

    const figure = page.getByRole("group", { name: "Throughput (done per day)" });
    await figure.scrollIntoViewIfNeeded();
    const marks = figure.locator("[data-tip-mark]");
    await expect(marks).toHaveCount(DAYS);

    for (const mark of [marks.first(), marks.last()]) {
      await mark.hover();
      const tip = figure.getByRole("tooltip");
      await expect(tip).toBeVisible();
      const [box, within] = await Promise.all([tip.boundingBox(), figure.boundingBox()]);
      expect(box!.x).toBeGreaterThanOrEqual(within!.x);
      expect(box!.x + box!.width).toBeLessThanOrEqual(within!.x + within!.width);
    }
  } finally {
    await page.request.patch(`/api/projects/${active.id}`, { data: { unlockAllSentinels: false } });
  }
});
