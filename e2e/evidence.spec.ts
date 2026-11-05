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
 * Record first, then gate: every axe violation is written down, and then any
 * violation, of any impact, fails the test. A page that does not render fails too, as there is nothing to record.
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
  mkdirSync(join(OUT, "axe-passes"), { recursive: true });
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
      // Switching theme starts colour transitions (the sentinels grade badge
      // fades its background over 400ms). A scan taken mid-fade reads blended
      // colours no one sees at rest, so wait for them to land.
      await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => undefined))));

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
          passed: scan.passes.length,
        }),
      );
      // The rule ids live outside the axe/ folder: they are not a scan (no
      // `violations` key), and a grep for a rule id there reads only failures.
      writeFileSync(
        join(OUT, "axe-passes", `${file}.json`),
        JSON.stringify({ url: `${new URL(page.url()).pathname} (${shot.name}, ${theme})`, passes: scan.passes.map((p) => p.id) }),
      );

      // The evidence is on disk; now hold the page to it.
      // Any violation fails, whatever its impact. color-contrast is one of the
      // scanned rules, so text stays held to 4.5:1 (design/DESIGN.md).
      expect(
        scan.violations.map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.map((n) => n.target.join(" ")).join("; ")}`),
        `axe violations on ${shot.name} in the ${theme} theme`,
      ).toEqual([]);
    });
  }
}

test("records the board at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoBoard(page);
  await page.screenshot({ path: join(OUT, "screens", "board-mobile.png") });
});
