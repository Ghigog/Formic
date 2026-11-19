import { expect, test } from "@playwright/test";
import { gotoBoard } from "./board";

test.use({ hasTouch: true });

test("the project switcher opens above the Sentinels page at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await gotoBoard(page);
  await page.getByRole("button", { name: /Audit grade/ }).click();
  await expect(page.getByRole("region", { name: "Sentinels" })).toBeVisible();

  await page.getByRole("button", { name: /Choose another project/ }).tap();
  const search = page.getByRole("textbox", { name: "Search repositories" });
  await expect(search).toBeVisible();

  const onTop = await search.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return hit === el;
  });
  expect(onTop).toBe(true);

  await search.fill("acme");
  await expect(search).toHaveValue("acme");
});
