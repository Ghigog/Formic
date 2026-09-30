import { expect, test } from "@playwright/test";
import { card, dragTo, gotoBoard } from "./board";

test("dragging a ticket onto the archive zone archives it", async ({ page }) => {
  await gotoBoard(page);
  // The first ticket on screen that is not running: epics cannot be archived.
  const board = await page.request.get("/api/board");
  const { cards } = (await board.json()) as {
    cards: Array<{ id: string; kind: string; status: string }>;
  };
  let id = "";
  for (const c of cards) {
    if (c.kind !== "ticket" || c.status === "running") continue;
    if (await card(page, c.id).isVisible()) {
      id = c.id;
      break;
    }
  }
  expect(id, "the demo board should show an idle ticket").toBeTruthy();
  const source = card(page, id);
  await expect(source).toBeVisible();

  const zone = page.getByRole("region", { name: "Archive", exact: true });
  const bar = zone.locator("[data-hidden]");
  await expect(bar).toHaveAttribute("data-hidden", "true");
  const from = await source.boundingBox();
  const into = await zone.boundingBox();
  if (!from || !into) throw new Error("Nothing to measure.");
  await dragTo(page, from, into.x + into.width / 2, into.y + into.height / 2);

  await expect(source).toHaveCount(0);
});
