import { expect, test } from "@playwright/test";
import { card, dragTo, gotoBoard, idForKey } from "./board";

test("dragging a ticket onto the archive zone archives it", async ({ page }) => {
  await gotoBoard(page);
  // PROT-04 is in review with no active run, so it can be archived, and no other spec uses it.
  // The store is shared, so archiving another card would take it from the specs that run later.
  const id = await idForKey(page, "PROT-04");
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
