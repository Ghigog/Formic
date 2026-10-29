import { expect, test } from "@playwright/test";
import { gotoBoard } from "./board";

/**
 * Swapping boards with a real drag of the swap handle: the next board slides
 * in after the dirt band. Two boards without a repository are made through
 * the API so the picker order has somewhere to go.
 */
test("dragging the swap handle down loads the next board", async ({ page }) => {
  await gotoBoard(page);
  const made = [];
  for (const name of ["Swap one", "Swap two"]) {
    const res = await page.request.post("/api/projects", { data: { noRepository: true, name } });
    made.push(res.ok());
  }
  expect(made).toEqual([true, true]);
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const handle = page.getByRole("button", { name: /swap board/i });
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 100, { steps: 8 });
  await page.mouse.up();

  await expect(page.getByTestId("dirt-band")).toHaveCount(0);
  await expect(page.locator(".board-swap")).toBeVisible();
});
