import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Rule = { selectors: string[]; body: string; reduced: boolean };

/** Flattens the stylesheet to style rules, noting whether each sits in a reduced-motion media query. */
function parseRules(css: string): { rules: Rule[]; keyframes: string[] } {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  const keyframes: string[] = [];
  const stack: { reduced: boolean; keyframes: boolean }[] = [];
  let i = 0;
  let head = "";
  while (i < src.length) {
    const ch = src[i++];
    if (ch === "{") {
      const prelude = head.trim();
      head = "";
      const parent = stack[stack.length - 1];
      const inKeyframes = parent?.keyframes ?? false;
      const reduced = (parent?.reduced ?? false) || /^@media[^{]*prefers-reduced-motion:\s*reduce/.test(prelude);
      if (prelude.startsWith("@keyframes")) {
        keyframes.push(prelude.replace("@keyframes", "").trim());
        stack.push({ reduced, keyframes: true });
      } else if (prelude.startsWith("@") || inKeyframes) {
        stack.push({ reduced, keyframes: inKeyframes });
      } else {
        let depth = 1;
        let j = i;
        while (depth > 0 && j < src.length) {
          if (src[j] === "{") depth++;
          else if (src[j] === "}") depth--;
          j++;
        }
        rules.push({ selectors: prelude.split(",").map((s) => s.trim()), body: src.slice(i, j - 1), reduced });
        i = j;
      }
    } else if (ch === "}") {
      stack.pop();
      head = "";
    } else if (ch === ";" && stack.length === 0) {
      head = "";
    } else {
      head += ch;
    }
  }
  return { rules, keyframes };
}

/** The element a selector styles: its last compound, so `.a[x] .b` and `.a .b` both mean `.b`. */
const target = (selector: string) => (selector.split(/\s+/).pop() ?? selector).replace(/\[[^\]]*\]/g, "");

/**
 * Keyframes with no CSS rule of their own: components apply them with Tailwind's
 * animate-[...], gated on motion-safe/motion-reduce or the .sentinel-motion class,
 * or (tlStripe) from a JS style that checks prefers-reduced-motion.
 */
const USED_FROM_COMPONENTS = [
  "auditSweep",
  "tlStripe",
  "tlPing",
  "reqFade",
  "reqPop",
  "reqSlideDown",
  "sentinelScan",
  "sentinelBob",
  "sentinelLine",
  "sentinelFade",
];

describe("reduced motion", () => {
  const { rules, keyframes } = parseRules(readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8"));
  const reducedTargets = new Set(rules.filter((r) => r.reduced).flatMap((r) => r.selectors.map(target)));

  it.each(keyframes)("@keyframes %s is turned off under prefers-reduced-motion", (name) => {
    const users = rules.filter((r) => !r.reduced && new RegExp(`animation:[^;]*\\b${name}\\b`).test(r.body));
    if (users.length === 0) {
      const inReducedBlock = rules.some((r) => r.reduced && r.body.includes(name));
      expect(inReducedBlock || USED_FROM_COMPONENTS.includes(name)).toBe(true);
      return;
    }
    for (const rule of users) {
      for (const selector of rule.selectors) expect(reducedTargets, selector).toContain(target(selector));
    }
  });

  it("covers every .dig-earth animation, including the scroll loops", () => {
    for (const name of ["digScrollNearUp", "digScrollFarUp", "digScrollNearDown", "digScrollFarDown"]) {
      expect(keyframes).toContain(name);
    }
    for (const el of [".dig-earth", ".dig-earth-near", ".dig-earth-far"]) expect(reducedTargets).toContain(el);
  });
});
