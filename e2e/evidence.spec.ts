import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { gotoBoard } from "./board";

/**
 * What the Sentinels cannot see from source: the app as it renders. Each
 * page is photographed and scanned with axe-core, in both themes, and the
 * results land in e2e/.evidence, which CI uploads as `sentinel-evidence`
 * for the Designer, Accessibility and Marketer to read. See docs/sentinels.md.
 *
 * A record, not a gate: an axe violation is written down, never failed on.
 * Only a page that does not render fails, because then there is nothing to
 * record.
 */

const OUT = fileURLToPath(new URL(".evidence", import.meta.url));

interface Shot {
  name: string;
  open: (page: Page) => Promise<void>;
}

/**
 * The runner-setup dialog opens once its state loads, which can land after
 * the board does. It is what a person would see, so the board's own shots
 * keep it; a shot that needs the board behind it closes it first.
 */
async function closeSetup(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  if (await dialog.waitFor({ timeout: 2_000 }).then(() => true, () => false)) {
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
}

const SHOTS: Shot[] = [
  { name: "board", open: gotoBoard },
  {
    name: "sentinels",
    open: async (page) => {
      await gotoBoard(page);
      await closeSetup(page);
      await page.getByRole("button", { name: /Audit grade/ }).click();
      await expect(page.getByRole("region", { name: "Sentinels" })).toBeVisible();
    },
  },
  {
    name: "settings",
    open: async (page) => {
      await page.goto("/settings", { waitUntil: "domcontentloaded" });
      await expect(page.locator("main, body").first()).toBeVisible();
    },
  },
  {
    name: "legal",
    open: async (page) => {
      await page.goto("/legal", { waitUntil: "domcontentloaded" });
      await expect(page.locator("main, body").first()).toBeVisible();
    },
  },
];

const THEMES = ["light", "dark"] as const;

test.beforeAll(() => {
  mkdirSync(join(OUT, "screens"), { recursive: true });
  mkdirSync(join(OUT, "axe"), { recursive: true });
});

for (const shot of SHOTS) {
  for (const theme of THEMES) {
    test(`records ${shot.name} in the ${theme} theme`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await shot.open(page);
      // Dark is opt-in through data-theme, which nothing in the app persists
      // yet, so it is set on the page as a person's toggle would.
      await page.evaluate((t) => {
        if (t === "dark") document.documentElement.setAttribute("data-theme", "dark");
        else document.documentElement.removeAttribute("data-theme");
      }, theme);
      // Let fonts and the first paint settle before the photograph.
      await page.evaluate(() => document.fonts.ready);

      const file = `${shot.name}-${theme}`;
      await page.screenshot({ path: join(OUT, "screens", `${file}.png`) });

      const scan = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      writeFileSync(
        join(OUT, "axe", `${file}.json`),
        JSON.stringify({
          url: `${new URL(page.url()).pathname} (${shot.name}, ${theme})`,
          violations: scan.violations.map((v) => ({
            id: v.id,
            impact: v.impact ?? null,
            help: v.help,
            nodes: v.nodes.map((n) => ({ target: n.target })),
          })),
          passes: scan.passes.map((p) => p.id),
        }),
      );
    });
  }
}

test("records the board at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoBoard(page);
  await page.screenshot({ path: join(OUT, "screens", "board-mobile.png") });
});
