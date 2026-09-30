import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { GROUP_GROUND, SENTINELS } from "@/lib/sentinels/roster";
import { PORTRAITS, portraitFor, portraitGround } from "./portraits";
import { TRACED } from "./portraits.traced";

/**
 * The only thing joining the roster, the portraits and the source art is a
 * name, and the way that fails is quiet: `PORTRAITS[pic]` renders an empty
 * card with no error, no type warning and no failing test. This file is what
 * makes the convention safe — in both directions, naming the key at fault.
 */

const root = fileURLToPath(new URL("../../..", import.meta.url));
const artDir = path.join(root, "design/portraits");

/** The pic keys that have source art in `design/portraits`. */
const traced = readdirSync(artDir)
  .filter((name) => name.endsWith(".svg"))
  .map((name) => path.basename(name, ".svg"))
  .sort();

const rosterPics = [...new Set(SENTINELS.map((s) => s.pic))].sort();

describe("the roster and its portraits", () => {
  it("draws a portrait for every pic the roster names", () => {
    const missing = rosterPics.filter((pic) => !(pic in PORTRAITS));
    expect(missing, `no portrait drawn for: ${missing.join(", ")}`).toEqual([]);
  });

  it("claims no portrait the roster does not name", () => {
    const named = new Set(rosterPics);
    const orphans = Object.keys(PORTRAITS).filter((key) => !named.has(key));
    expect(orphans, `portraits no sentinel is keyed to: ${orphans.join(", ")}`).toEqual([]);
  });

  it("keeps the source art and the roster's pics the same names", () => {
    const stray = traced.filter((key) => !rosterPics.includes(key));
    expect(stray, `art no sentinel is keyed to: ${stray.join(", ")}`).toEqual([]);
  });

  it("paints every portrait on its sentinel's tint", () => {
    for (const sentinel of SENTINELS) {
      expect(portraitGround(sentinel.pic), `${sentinel.pic}: no ground to paint`).toBe(
        GROUP_GROUND[sentinel.group],
      );
      expect(
        portraitGround(sentinel.pic),
        `${sentinel.pic}: the ground is a colour, so it cannot follow the theme`,
      ).toMatch(/^var\(--[\w-]+\)$/);
    }
  });

  it("draws no ground of its own, and leaves the figure to the app's ink", () => {
    for (const sentinel of SENTINELS) {
      const picture = portraitFor(sentinel.pic);
      expect(picture, `${sentinel.pic} draws its own ground`).not.toMatch(
        /^<rect width="200" height="200"/,
      );
      expect(picture, `${sentinel.pic} is not drawn in the app's ink`).toContain(
        'fill="var(--text)"',
      );
      expect(picture, `${sentinel.pic} is drawn white, which reads on nothing`).not.toMatch(
        /fill="#(?:fff|ffffff)"/i,
      );
    }
  });
});

describe("the generated portraits", () => {
  it("are what the committed art draws", () => {
    // The script writes nothing in --check: it compares the art in
    // design/portraits to the module that ships and names the way back.
    try {
      execFileSync(process.execPath, [path.join(root, "scripts/build-portraits.mjs"), "--check"], {
        cwd: root,
        stdio: "pipe",
      });
    } catch (error) {
      const detail = (error as { stderr?: Buffer }).stderr?.toString().trim();
      throw new Error(`the portraits have drifted from the art.\n${detail ?? error}`);
    }
  });

  it("ships a portrait for every drawing in design/portraits", () => {
    const unshipped = traced.filter((key) => !(key in TRACED));
    expect(unshipped, `art that never reached the page: ${unshipped.join(", ")}`).toEqual([]);
  });

  it("traces no portrait the art directory does not hold", () => {
    const stray = Object.keys(TRACED).filter((key) => !traced.includes(key));
    expect(stray, `traced portraits with no drawing behind them: ${stray.join(", ")}`).toEqual([]);
  });
});

describe("a pic nobody drew", () => {
  it("renders a marked placeholder rather than an empty card", () => {
    const picture = portraitFor("nobody");
    expect(picture).toContain(">N</text>");
    expect(picture, "the placeholder is not marked as missing").toContain("stroke-dasharray");
    expect(portraitGround("nobody"), "the placeholder is not on the column ground").toBe(
      "var(--column)",
    );
  });

  it("escapes a key that is not a word", () => {
    expect(portraitFor('<script>alert("x")</script>')).not.toContain("<script>");
  });

  it("hands back the art for a pic that has some", () => {
    for (const pic of rosterPics) {
      expect(portraitFor(pic)).toBe(PORTRAITS[pic]);
    }
  });
});
