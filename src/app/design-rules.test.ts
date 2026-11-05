import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** design/DESIGN.md: the closed type scale, plus the two sizes the brief keeps. */
const TEXT_SIZES = new Set([
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  16,
  18,
  20,
  22,
  28,
  32, // scale
  8,
  42, // keep exceptions
]);

/** Padding, margin, gap and space utilities (with any variant prefix and side). */
const OFF_GRID_SPACING =
  /(?<![\w-])(?:[a-z-]+:)*-?(?:p[xytblrse]?|m[xytblrse]?|gap(?:-[xy])?|space-[xy])-\[(?:9|10|14|18)px\]/g;
const TEXT_PX = /(?<![\w-])text-\[(\d+(?:\.\d+)?)px\]/g;
/** The old CTA utility (bg-/text-/border-... terracotta-cta), not the var(--terracotta-cta) variable. */
const OLD_CTA =
  /(?<!var\(--)(?<![\w-])(?:[a-z-]+:)*[a-z]+-terracotta-cta(?![\w-])/g;

/** Every .ts/.tsx under dir that is not a test. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)
      ? [path]
      : [];
  });
}

/** `file:line: match` for every match of `pattern` that `bad` accepts. */
function scan(
  pattern: RegExp,
  bad: (m: RegExpMatchArray) => boolean = () => true,
): string[] {
  const hits: string[] = [];
  for (const dir of ["src/app", "src/components"]) {
    for (const file of sourceFiles(join(process.cwd(), dir))) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          for (const m of line.matchAll(pattern))
            if (bad(m))
              hits.push(
                `${file.replace(process.cwd() + "/", "")}:${i + 1}: ${m[0]}`,
              );
        });
    }
  }
  return hits;
}

describe("design rules", () => {
  it("uses only sizes from the type scale in text-[Npx]", () => {
    expect(scan(TEXT_PX, (m) => !TEXT_SIZES.has(Number(m[1])))).toEqual([]);
  });

  it("keeps spacing on the grid (no 9, 10, 14 or 18px)", () => {
    expect(scan(OFF_GRID_SPACING)).toEqual([]);
  });

  it("uses no terracotta-cta utility (the --terracotta-cta variable is fine)", () => {
    expect(scan(OLD_CTA)).toEqual([]);
  });
});
