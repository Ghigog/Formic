import { expect, test, type Page } from "@playwright/test";
import { gotoBoard } from "./board";

/**
 * Swapping boards with a real right-button drag: the board digs through the
 * earth to the next board in the picker's order, and that board is the one
 * left open. Two boards without a repository give the order somewhere to go.
 * The three-finger swipe is in mobile.spec.ts.
 */

/** The board in view, by the name its header shows. */
async function shownBoard(page: Page): Promise<string> {
  const label = (await page.getByRole("button", { name: /^Project: / }).first().getAttribute("aria-label")) ?? "";
  return label.replace(/^Project: /, "").replace(/\. Choose another project$/, "");
}

/** The board a swap from `name` lands on: the next one down, or up from the last. */
async function neighbour(page: Page, name: string): Promise<{ name: string; down: boolean }> {
  const order = ((await (await page.request.get("/api/projects")).json()) as { projects: Array<{ name: string }> }).projects.map((p) => p.name);
  const i = order.indexOf(name);
  const down = i + 1 < order.length;
  return { name: order[down ? i + 1 : i - 1]!, down };
}

test("a right-button drag digs through the earth to the neighbouring board", async ({ page }) => {
  await gotoBoard(page);
  for (const name of ["Swap one", "Swap two"]) {
    expect((await page.request.post("/api/projects", { data: { noRepository: true, name } })).ok()).toBe(true);
  }
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const { name: expected, down } = await neighbour(page, await shownBoard(page));

  await expect(page.getByRole("button", { name: /swap board/i })).toHaveCount(0);
  const x = 700;
  const y = 500;
  await page.mouse.move(x, y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(x, y + (down ? -140 : 140), { steps: 10 });
  await page.mouse.up({ button: "right" });

  await expect.poll(() => shownBoard(page), { timeout: 10_000 }).toBe(expected);
  await expect(page.getByTestId("dig-transition")).toHaveAttribute("data-phase", "idle");
  await expect(page.getByTestId("dig-band")).toHaveCount(0);
});
