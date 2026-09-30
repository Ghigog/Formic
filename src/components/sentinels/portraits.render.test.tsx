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
    it(`is markup a browser will parse: ${sentinel.pic}`, () => {
      const doc = new DOMParser().parseFromString(framed(sentinel.pic), "image/svg+xml");
      expect(doc.querySelector("parsererror"), "the portrait is not well-formed").toBeNull();
      expect(doc.documentElement.tagName.toLowerCase()).toBe("svg");
    });

    it(`fills its frame edge to edge: ${sentinel.pic}`, () => {
      const host = document.createElement("div");
      host.innerHTML = framed(sentinel.pic);
      const svg = host.querySelector("svg")!;
      expect(svg.getAttribute("viewBox"), "the frame moved").toBe("0 0 200 200");
      expect(svg.getAttribute("preserveAspectRatio")).toBe("xMidYMid slice");

      // The ground is the first thing drawn and it is the whole frame, so no
      // crop — the header band or the round avatar — can show a gap behind it.
      const ground = svg.firstElementChild!;
      expect(ground.tagName.toLowerCase()).toBe("rect");
      expect(ground.getAttribute("width")).toBe("200");
      expect(ground.getAttribute("height")).toBe("200");
      expect(ground.getAttribute("fill")).toBeTruthy();
      expect(svg.querySelectorAll("rect")[0]).toBe(ground);
    });

    it(`brings no motion and no outside reference: ${sentinel.pic}`, () => {
      const markup = framed(sentinel.pic);
      expect(markup).not.toMatch(FORBIDDEN);
      expect(markup).not.toMatch(/@keyframes|animation\s*:/);
      expect(markup, "the art reaches outside itself").not.toMatch(
        /(?:href|src)\s*=\s*["'](?!\s*#)/,
      );
    });
  }

  it("renders a marked placeholder for a pic nobody drew", () => {
    const host = document.createElement("div");
    host.innerHTML = framed("nobody");
    const svg = host.querySelector("svg")!;
    expect(svg.querySelector("text")?.textContent).toBe("N");
    expect(svg.querySelector("circle")?.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(svg.firstElementChild?.getAttribute("fill")).toBe("var(--column)");
    expect(portraitFor("nobody")).not.toBe("");
  });
});
