import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Page helpers for the board.
 *
 * Two things here are worth knowing before writing a test with them.
 *
 * The drag is a real mouse drag in small steps. @hello-pangea/dnd starts a
 * drag on a 5px threshold and then tracks the pointer, so a single
 * `mouse.move` from source to target is ignored — the library never sees the
 * intermediate positions it uses to decide what the card is over.
 *
 * The board runs on one in-memory store shared by the whole run, so a test
 * that moves a card has changed the board for every test after it. Move it
 * back, or use `withCardReturned`.
 */

export const COLUMNS = [
  "Backlog",
  "To Do",
  "In Progress",
  "In Review",
  "Done",
] as const;

export type ColumnName = (typeof COLUMNS)[number];

/** Maps a column's visible name to the droppable id the board uses. */
const DROPPABLE_ID: Record<ColumnName, string> = {
  Backlog: "backlog",
  "To Do": "todo",
  "In Progress": "in_progress",
  "In Review": "in_review",
  Done: "done",
};

export function column(page: Page, name: ColumnName): Locator {
  return page.getByRole("region", { name, exact: true });
}

export function dropzone(page: Page, name: ColumnName): Locator {
  return page.locator(`ul[data-rfd-droppable-id="${DROPPABLE_ID[name]}"]`);
}

export function card(page: Page, cardId: string): Locator {
  return page.locator(`[data-rfd-draggable-id="${cardId}"]`);
}

/**
 * The column a card is currently rendered in, by its visible name.
 *
 * Throws if the card is not on screen — which below 768px is every card
 * outside the active tab, because the board renders one column at a time.
 * On mobile, switch to the tab first or assert through the API.
 */
export async function columnOf(page: Page, cardId: string): Promise<ColumnName> {
  const name = await card(page, cardId)
    .locator("xpath=ancestor::section[@aria-label]")
    .first()
    .getAttribute("aria-label");

  const match = COLUMNS.find((c) => c === name);
  if (!match) throw new Error(`Card ${cardId} is not in a known column (${name}).`);
  return match;
}

/** Look up a card's id by the key shown on it, e.g. "PROT-05". */
export async function idForKey(page: Page, key: string): Promise<string> {
  const board = await page.request.get("/api/board");
  const { cards } = (await board.json()) as Array<never> &
    { cards: Array<{ id: string; key: string }> };
  const card = cards.find((c) => c.key === key);
  if (!card) throw new Error(`No card on the board has the key ${key}.`);
  return card.id;
}

/** Every card id rendered in a column, in order. */
export async function cardIds(page: Page, name: ColumnName): Promise<string[]> {
  return dropzone(page, name)
    .locator("[data-rfd-draggable-id]")
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-rfd-draggable-id") ?? ""),
    );
}

export async function gotoBoard(page: Page): Promise<void> {
  // Not `networkidle`: the board holds an SSE connection to /api/events open
  // for the life of the page, so the network is never idle.
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(column(page, "Backlog")).toBeVisible();
}

/**
 * Drag a card into a column. Resolves once the board has re-rendered with the
 * card in its new home, or throws if it did not move.
 */
export async function dragCardTo(
  page: Page,
  cardId: string,
  to: ColumnName,
  /** Lower it when the move is expected to be refused, so the wait is short. */
  timeout = 10_000,
): Promise<void> {
  const source = card(page, cardId);
  const target = dropzone(page, to);

  const from = await source.boundingBox();
  const into = await target.boundingBox();
  if (!from || !into) throw new Error(`Cannot drag ${cardId}: nothing to measure.`);

  const startX = from.x + from.width / 2;
  const startY = from.y + Math.min(20, from.height / 2);
  const endX = into.x + into.width / 2;
  const endY = into.y + 40;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Small steps: the library needs to see the pointer cross the drag
  // threshold and then move over the destination.
  for (let i = 1; i <= 15; i++) {
    await page.mouse.move(
      startX + ((endX - startX) * i) / 15,
      startY + ((endY - startY) * i) / 15,
    );
  }
  await page.mouse.up();

  await expect.poll(() => columnOf(page, cardId), { timeout }).toBe(to);
}

/**
 * Move a card through the API rather than the UI, one column at a time.
 *
 * For putting the board back where a test found it when the UI cannot: the
 * mobile advance action only moves forward, so a test that used it has no
 * gesture to undo it with. `canUserMove` still applies, so this cannot park a
 * card somewhere a user could not have.
 */
export async function moveViaApi(
  page: Page,
  cardId: string,
  path: readonly ColumnName[],
): Promise<void> {
  const board = await page.request.get("/api/board");
  const { cards } = (await board.json()) as {
    cards: Array<{ id: string; kind: string }>;
  };
  const kind = cards.find((c) => c.id === cardId)?.kind ?? "ticket";

  for (let i = 1; i < path.length; i++) {
    const response = await page.request.post("/api/transitions", {
      data: {
        cardId,
        kind,
        from: DROPPABLE_ID[path[i - 1]!],
        to: DROPPABLE_ID[path[i]!],
        position: 0,
        actor: "user",
      },
    });
    if (!response.ok()) {
      throw new Error(
        `Could not move ${cardId} ${path[i - 1]} to ${path[i]}: ${await response.text()}`,
      );
    }
  }
  await page.reload({ waitUntil: "domcontentloaded" });
}

/**
 * Run a test body that moves a card, then put the card back. Use it for any
 * mutation, so the next test starts from the board it expects.
 */
export async function withCardReturned(
  page: Page,
  cardId: string,
  body: () => Promise<void>,
): Promise<void> {
  const home = await columnOf(page, cardId);
  try {
    await body();
  } finally {
    const now = await columnOf(page, cardId);
    // Through the API, not by dragging it back: a restore that depends on
    // layout can fail for the same reason the test it is cleaning up after
    // did, and then every later test inherits the mess.
    if (now !== home) await moveViaApi(page, cardId, [now, home]);
  }
}
