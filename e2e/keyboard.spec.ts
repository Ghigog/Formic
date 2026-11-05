import { expect, test } from "@playwright/test";
import {
  cardIds,
  columnOf,
  gotoBoard,
  keyboardMoveCard,
  withCardReturned,
} from "./board";

/** The board moves by keyboard alone: no mouse call anywhere in this file. */

test("a card moves to the next column with Space, ArrowRight, Space", async ({
  page,
}) => {
  await gotoBoard(page);
  const [first] = await cardIds(page, "Backlog");
  expect(first, "the demo board should start with a card in Backlog").toBeTruthy();

  await withCardReturned(page, first!, async () => {
    await keyboardMoveCard(page, first!, "To Do");
    expect(await columnOf(page, first!)).toBe("To Do");

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(() => columnOf(page, first!)).toBe("To Do");
  });
});
