import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Rule = { selectors: string[]; body: string; reduced: boolean };

/** Flattens the stylesheet to style rules, noting whether each sits in a reduced-motion media query. */
function parseRules(css: string): {
  rules: Rule[];
  keyframes: string[];
  reducedKeyframes: string[];
} {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  const keyframes: string[] = [];
  const reducedKeyframes: string[] = [];
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
      const reduced =
        (parent?.reduced ?? false) ||
        /^@media[^{]*prefers-reduced-motion:\s*reduce/.test(prelude);
      if (prelude.startsWith("@keyframes")) {
        const name = prelude.replace("@keyframes", "").trim();
        if (reduced) reducedKeyframes.push(name);
        else keyframes.push(name);
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
        rules.push({
          selectors: prelude.split(",").map((s) => s.trim()),
          body: src.slice(i, j - 1),
          reduced,
        });
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
  return { rules, keyframes, reducedKeyframes };
}

/** The element a selector styles: its last compound, so `.a[x] .b` and `.a .b` both mean `.b`. */
const target = (selector: string) =>
  (selector.split(/\s+/).pop() ?? selector).replace(/\[[^\]]*\]/g, "");

/** Every .tsx under src/components and src/app that is not a test. */
function componentFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return componentFiles(path);
    return e.name.endsWith(".tsx") && !/\.test\.tsx$/.test(e.name)
      ? [path]
      : [];
  });
}

describe("reduced motion", () => {
  const { rules, keyframes, reducedKeyframes } = parseRules(
    readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8"),
  );
  const reducedTargets = new Set(
    rules.filter((r) => r.reduced).flatMap((r) => r.selectors.map(target)),
  );

  it.each(keyframes)(
    "@keyframes %s is turned off under prefers-reduced-motion",
    (name) => {
      const users = rules.filter(
        (r) =>
          !r.reduced && new RegExp(`animation:[^;]*\\b${name}\\b`).test(r.body),
      );
      expect(
        reducedKeyframes,
        `${name} has no override in a reduced-motion block`,
      ).toContain(name);
      for (const rule of users) {
        for (const selector of rule.selectors)
          expect(reducedTargets, selector).toContain(target(selector));
      }
    },
  );

  it("covers every .dig-earth animation, including the scroll loops", () => {
    for (const name of [
      "digScrollNearUp",
      "digScrollFarUp",
      "digScrollNearDown",
      "digScrollFarDown",
    ]) {
      expect(keyframes).toContain(name);
    }
    for (const el of [".dig-earth", ".dig-earth-near", ".dig-earth-far"])
      expect(reducedTargets).toContain(el);
  });

  it("gates every animate-[keyframe] in a component on motion-safe:, motion-reduce:hidden or .sentinel-motion", () => {
    const names = keyframes.join("|");
    const use = new RegExp(
      `(motion-safe:)?animate-\\[(${names})(?=[_\\]])`,
      "g",
    );
    const ungated: string[] = [];
    for (const dir of ["src/components", "src/app"]) {
      for (const file of componentFiles(join(process.cwd(), dir))) {
        const src = readFileSync(file, "utf8");
        for (const m of src.matchAll(use)) {
          if (m[1]) continue;
          const at = m.index ?? 0;
          const start = Math.max(
            src.lastIndexOf('"', at),
            src.lastIndexOf("`", at),
          );
          const end = src.indexOf(src.charAt(start), at);
          if (
            !/sentinel-motion|motion-reduce:hidden/.test(src.slice(start, end))
          )
            ungated.push(`${file}: ${m[0]}`);
        }
      }
    }

    expect(ungated).toEqual([]);
  });
});
