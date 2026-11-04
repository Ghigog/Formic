import { expect, test } from "@playwright/test";
import { gotoBoard } from "./board";

/** The production CSP only allows nonce'd scripts: the pages must still hydrate under it. */
test("the board and the sign-in page load with no CSP violation", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /content security policy/i.test(m.text())) problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(e.message));

  await gotoBoard(page);
  await page.goto("/login");
  await page.waitForLoadState("networkidle");

  expect(problems).toEqual([]);
});
