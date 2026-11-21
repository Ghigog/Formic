import { expect, test } from "@playwright/test";
import { gotoBoard } from "./board";

/**
 * Dragging a selection down past the PM thread, so it scrolls, must keep the
 * highlight inside the thread. Only a real browser clamps a selection, so this
 * is the one place it is checked.
 */

const messages = Array.from({ length: 30 }, (_, i) => ({
  id: `m${i}`,
  role: "assistant",
  content: `Answer number ${i}. The PM explains this part of the repository at some length.`,
  status: "done",
  proposals: [],
  cards: [],
  attachments: [],
  createdAt: "2026-01-01T00:00:00.000Z",
}));

test("a drag from inside a PM message stays inside the thread", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.route("**/api/assistant", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: {
            presetId: null,
            readAt: "2026-01-01T00:00:00.000Z",
            messages,
          },
        })
      : route.continue(),
  );
  await gotoBoard(page);
  await page.getByRole("button", { name: "Ask the PM" }).click();

  const shade = page.locator("section[aria-label=PM]");
  const thread = shade.locator(".pm-thread");
  await expect(thread.getByText("Answer number 29.")).toBeVisible();
  await thread.evaluate((el) => (el.scrollTop = 0));

  const from = await thread.getByText("Answer number 1.").boundingBox();
  const box = (await shade.boundingBox())!;
  await page.mouse.move(from!.x + 4, from!.y + 8);
  await page.mouse.down();
  await page.mouse.move(from!.x + 40, box.y + box.height - 20, { steps: 10 });
  await page.mouse.move(from!.x + 40, box.y + box.height + 120, { steps: 10 });
  await page.waitForTimeout(600);
  await page.mouse.up();

  const result = await page.evaluate(() => {
    const sel = window.getSelection()!;
    const thread = document.querySelector(".pm-thread")!;
    const frag = sel.getRangeAt(0).cloneContents();
    return {
      text: sel.toString(),
      anchorInside: thread.contains(sel.anchorNode),
      // Nothing but PM messages is highlighted. The focus node itself may sit
      // in unselectable chrome when the drag runs off the end of the thread,
      // so judge by the selected text, not by where the focus is reported.
      onlyMessages:
        sel
          .toString()
          .replace(
            /Answer number \d+\. The PM explains this part of the repository at some length\./g,
            "",
          )
          .trim() === "",
      hasHeader: /Clear/.test(sel.toString()),
      attr: document.documentElement.hasAttribute("data-pm-selecting"),
      nodes: frag.childNodes.length,
    };
  });
  expect(result.text.length).toBeGreaterThan(0);
  expect(result.anchorInside).toBe(true);
  expect(result.onlyMessages).toBe(true);
  expect(result.hasHeader).toBe(false);
  expect(result.attr).toBe(false);
  await expect(
    page.getByRole("region", { name: "Backlog", exact: true }),
  ).toBeVisible();
  expect(result.text).not.toContain("Backlog");
});
