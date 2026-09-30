import { describe, expect, it } from "vitest";

import { SENTINELS } from "@/lib/sentinels/roster";
import { portraitFor, portraitSvg } from "./portraits";

/**
 * A portrait as the page inlines it, checked through the two parsers the page
 * and the browser bring to it.
 *
 * The app hands the markup to `dangerouslySetInnerHTML` inside an HTML
 * document, so it has to be markup the HTML parser will take — and it has to
 * be well-formed XML besides, which the strict parser in `DOMParser` is what
 * proves. Two things only show up here: that the frame is filled at both
 * crops, and that the art brings no motion and no outside reference of its
 * own, since the page's only animation is a class it decides to add.
 */

/** A portrait in the frame the page uses — the same string, not a copy of it. */
const framed = portraitSvg;

/** Every element that would fetch, run, or move without the page asking. */
const FORBIDDEN = /<(?:animate|animateMotion|animateTransform|set|script|style|image|foreignObject|iframe|audio|video)\b/;

describe("a portrait as the page inlines it", () => {
  for (const sentinel of SENTINELS) {
    it(`is markup a browser will parse: ${sentinel.id}`, () => {
      const doc = new DOMParser().parseFromString(framed(sentinel.id), "image/svg+xml");
      expect(doc.querySelector("parsererror"), "the portrait is not well-formed").toBeNull();
      expect(doc.documentElement.tagName.toLowerCase()).toBe("svg");
    });

    it(`leaves the ground to the page, and draws the figure in the app's ink: ${sentinel.id}`, () => {
      const host = document.createElement("div");
      host.innerHTML = framed(sentinel.id);
      const svg = host.querySelector("svg")!;
      expect(svg.getAttribute("viewBox"), "the frame moved").toBe("0 0 200 200");
      expect(svg.getAttribute("preserveAspectRatio")).toBe("xMidYMid slice");

      // The portrait draws no ground: the card and the avatar paint the
      // sentinel's tint behind it, from `portraitGround`.
      const body = svg.innerHTML;
      expect(body, "the portrait draws a ground of its own").not.toMatch(
        /^<rect width="200" height="200"/,
      );
      // And the figure is the app's ink, not the white the artist drew it in —
      // white on a pale ground is a portrait nobody can see.
      expect(body, "the figure is not painted by the app").toMatch(
        /(?:fill|stroke)="var\(--text\)"/,
      );
      expect(body, "the figure is drawn white").not.toMatch(/(?:fill|stroke)="#(?:fff|ffffff)"/i);
    });

    it(`brings no motion and no outside reference: ${sentinel.id}`, () => {
      const markup = framed(sentinel.id);
      expect(markup).not.toMatch(FORBIDDEN);
      expect(markup).not.toMatch(/@keyframes|animation\s*:/);
      expect(markup, "the art reaches outside itself").not.toMatch(
        /(?:href|src)\s*=\s*["'](?!\s*#)/,
      );
    });
  }

  it("renders a marked placeholder for an id nobody drew", () => {
    const host = document.createElement("div");
    host.innerHTML = framed("nobody");
    const svg = host.querySelector("svg")!;
    expect(svg.querySelector("text")?.textContent).toBe("N");
    expect(svg.querySelector("circle")?.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(svg.firstElementChild?.getAttribute("fill")).toBe("var(--column)");
    expect(portraitFor("nobody")).not.toBe("");
  });
});
