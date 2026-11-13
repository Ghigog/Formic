import { expect, test, type Page } from "@playwright/test";
import { card, columnOf, dragTo, gotoBoard, idForKey } from "./board";

/**
 * Archiving and restoring, against the memory store the whole run shares.
 * PROT-04 (in review, no active run) and EPIC-01 with PROT-01 and PROT-02 are
 * used by no other spec, so archiving them takes nothing from specs that run
 * later; each test restores what it archived.
 */

async function dropOnArchiveZone(page: Page, id: string) {
  const source = card(page, id);
  await expect(source).toBeVisible();
  const zone = page.getByRole("region", { name: "Archive", exact: true });
  await expect(zone.locator("[data-hidden]")).toHaveAttribute("data-hidden", "true");
  const from = await source.boundingBox();
  const into = await zone.boundingBox();
  if (!from || !into) throw new Error("Nothing to measure.");
  await dragTo(page, from, into.x + into.width / 2, into.y + into.height / 2);
  await expect(source).toHaveCount(0);
}

async function archiveFromDrawer(page: Page, id: string, drawer = "Ticket detail") {
  await page.locator(`[data-rfd-draggable-id="${id}"]`).first().click();
  const dialog = page.getByRole("dialog", { name: drawer });
  await dialog.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(card(page, id)).toHaveCount(0);
}

/** Opens the Archived view from the colony popover and clicks the card to restore it. */
async function restoreFromArchive(page: Page, key: string) {
  const nest = page.getByRole("button", { name: "Open colony: levels and bug styles" }).first();
  await expect(async () => {
    if ((await nest.getAttribute("aria-expanded")) !== "true") await nest.click();
    await page.getByRole("button", { name: "Archived", exact: true }).click({ timeout: 1000 });
  }).toPass();
  const view = page.getByRole("dialog", { name: "Archived" });
  await view.getByRole("button", { name: new RegExp(`^Restore ${key} `) }).click();
  await expect(view.getByRole("button", { name: new RegExp(`^Restore ${key} `) })).toHaveCount(0);
  await page.getByTestId("archive-backdrop").click({ position: { x: 4, y: 4 } });
  await expect(view).toBeHidden();
}

test("dragging a ticket onto the archive zone archives it, and the Archived view restores it", async ({ page }) => {
  await gotoBoard(page);
  const id = await idForKey(page, "PROT-04");
  await dropOnArchiveZone(page, id);

  await restoreFromArchive(page, "PROT-04");
  await expect(card(page, id)).toBeVisible();
  expect(await columnOf(page, id)).toBe("In Review");

  await page.reload();
  await expect(card(page, id)).toBeVisible();
  expect(await columnOf(page, id)).toBe("In Review");
});

test("a ticket archived from its drawer comes back from the Archived view, after a reload too", async ({ page }) => {
  await gotoBoard(page);
  const id = await idForKey(page, "PROT-04");
  await archiveFromDrawer(page, id);

  await restoreFromArchive(page, "PROT-04");
  expect(await columnOf(page, id)).toBe("In Review");

  await page.reload();
  expect(await columnOf(page, id)).toBe("In Review");
});

test("restoring an Epic brings back its tickets, but not one archived on its own", async ({ page }) => {
  await gotoBoard(page);
  const epic = await idForKey(page, "EPIC-01");
  const first = await idForKey(page, "PROT-01");
  const second = await idForKey(page, "PROT-02");
  await archiveFromDrawer(page, second);
  await archiveFromDrawer(page, epic, "Epic detail");
  await expect(card(page, first)).toHaveCount(0);

  await restoreFromArchive(page, "EPIC-01");
  for (const where of ["before", "after a reload"]) {
    if (where !== "before") await page.reload();
    await expect(card(page, epic), where).toBeVisible();
    await expect(card(page, first), where).toBeVisible();
    await expect(card(page, second), where).toHaveCount(0);
  }

  // The ticket archived on its own is still in the archive: restore it too.
  await restoreFromArchive(page, "PROT-02");
  await expect(card(page, second)).toBeVisible();
});
