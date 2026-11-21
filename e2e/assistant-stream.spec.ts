import { expect, test } from "@playwright/test";
import { gotoBoard } from "./board";

/**
 * The PM chat's stream in a real browser: Formic's notices are timeline
 * lines, a reply sits directly under the question it answers, every message
 * copies its raw Markdown, text in a message can be selected, and Stop is on
 * the pending reply, stopping only that one.
 */

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const base = { status: "done", proposals: [], cards: [], attachments: [] };

const messages = [
  { ...base, id: "q1", role: "user", kind: "person", content: "Can you give me the **answer** first?", createdAt: at(0) },
  // Landed while the reply was pending: it must not split the question from its answer.
  { ...base, id: "n1", role: "assistant", kind: "notice", content: "Opened pull request #726", createdAt: at(1) },
  { ...base, id: "r1", role: "assistant", kind: "pm", content: "Here is the answer:\n- first\n- second", createdAt: at(2) },
  { ...base, id: "q2", role: "user", kind: "person", content: "And the next one?", createdAt: at(10) },
  { ...base, id: "r2", role: "assistant", kind: "pm", content: "", status: "pending", createdAt: at(10) },
];

test("the PM stream: notices as lines, answers under their questions, Copy and Stop", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const stops: unknown[] = [];
  await page.route("**/api/assistant", async (route) => {
    const method = route.request().method();
    if (method === "PATCH") stops.push(route.request().postDataJSON());
    if (method !== "GET" && method !== "PATCH") return route.continue();
    await route.fulfill({
      json: {
        presetId: null,
        readAt: at(100),
        messages:
          method === "PATCH"
            ? messages.map((m) => (m.id === "r2" ? { ...m, status: "failed", content: "Stopped." } : m))
            : messages,
      },
    });
  });
  await gotoBoard(page);
  await page.getByRole("button", { name: "Pull the PM down" }).click();

  const thread = page.locator("section[aria-label=PM] .pm-thread");
  await expect(thread.getByText("Here is the answer:")).toBeVisible();

  // The notice moved above the question; the answer sits right under it.
  const order = await thread.locator("[data-kind]").evaluateAll((els) =>
    els.map((el) => `${el.getAttribute("data-kind")}:${(el.textContent ?? "").slice(0, 12)}`),
  );
  expect(order.map((o) => o.split(":")[0])).toEqual(["notice", "person", "pm", "person", "pm"]);
  const notice = thread.getByRole("note");
  await expect(notice).toContainText("Opened pull request #726");
  await expect(notice.locator(".rounded-xl")).toHaveCount(0);

  // Copy gives the raw Markdown, not the rendered text.
  await thread.locator("[data-kind=pm]").first().getByRole("button", { name: "Copy message" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Here is the answer:\n- first\n- second");
  await thread.locator("[data-kind=person]").first().getByRole("button", { name: "Copy message" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Can you give me the **answer** first?");

  // Text in a message selects.
  await thread.getByText("And the next one?").dblclick();
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect("And the next one?").toContain(selected.trim());
  expect(selected.trim().length).toBeGreaterThan(0);

  // Send stays Send while a reply is pending; Stop is on that reply and stops only it.
  await expect(page.getByRole("button", { name: "Send" }).first()).toBeVisible();
  await thread.getByRole("button", { name: "Stop" }).click();
  await expect(thread.getByText("Stopped.")).toBeVisible();
  expect(stops).toEqual([{ messageId: "r2" }]);
});
