import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** The brief the code is held to. */
const BRIEF = readFileSync(join(process.cwd(), "design/DESIGN.md"), "utf8");

/** The text of the `## name` or `### name` section, up to the next heading. Throws if absent. */
function section(brief: string, name: string): string {
  const lines = brief.split("\n");
  const start = lines.findIndex((l) =>
    new RegExp(`^#{2,3} ${name}\\s*$`).test(l),
  );
  if (start < 0) throw new Error(`design/DESIGN.md has no "${name}" section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{2,3} /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** Rows of the table in a section, as `[first column, second column]`; throws if none. */
function tableRows(brief: string, name: string, row: RegExp): string[][] {
  const rows = section(brief, name)
    .split("\n")
    .map((l) => l.match(row))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => m.slice(1));
  if (rows.length === 0)
    throw new Error(`design/DESIGN.md "${name}" has no table rows`);
  return rows;
}

/** Pixel sizes in the Type scale table (`name  px  use`). */
function typeScale(brief: string): Set<number> {
  const rows = tableRows(brief, "Type", /^([a-z-]+)\s+(\d+)\s+\S/);
  return new Set(rows.map(([, px]) => Number(px)));
}

/** rounded utility -> px from the Radius table (`px  class[, class]  use`). */
function radiusScale(brief: string): Map<string, number> {
  const rows = tableRows(
    brief,
    "Radius",
    /^(\d+)\s+(rounded[\w-]*(?:, rounded[\w-]*)*)\s+\S/,
  );
  const map = new Map<string, number>();
  for (const [px, classes] of rows)
    for (const c of classes!.split(", ")) map.set(c, Number(px));
  return map;
}

/** Tailwind v4 named radii, in px. */
const TAILWIND_RADIUS: Record<string, number> = {
  "rounded-xs": 2,
  "rounded-sm": 4,
  rounded: 4,
  "rounded-md": 6,
  "rounded-lg": 8,
  "rounded-xl": 12,
  "rounded-2xl": 16,
  "rounded-3xl": 24,
  "rounded-full": 999,
};

/** Every @keyframes name in css that the Motion section does not mention as a word. */
function missingKeyframes(css: string, motion: string): string[] {
  const names = new Set(
    [...css.matchAll(/@keyframes ([A-Za-z-]+)/g)].map((m) => m[1]!),
  );
  return [...names].filter(
    (n) => !new RegExp(`(?<![\\w-])${n}(?![\\w-])`).test(motion),
  );
}

/** Padding, margin, gap and space utilities (with any variant prefix and side) given an arbitrary px/rem value. */
const ARBITRARY_SPACING =
  /(?<![\w-])(?:[a-z-]+:)*-?(?:p[xytblrse]?|m[xytblrse]?|gap(?:-[xy])?|space-[xy])-\[-?[\d.]+(?:px|rem)\]/g;
const ARBITRARY_RADIUS =
  /(?<![\w-])(?:[a-z-]+:)*rounded(?:-[a-z]{1,2})?-\[[^\]]*\]/g;
const NAMED_RADIUS =
  /(?<![\w-])(?:[a-z-]+:)*(rounded(?:-(?:xs|sm|md|lg|xl|2xl|3xl|full))?)(?![\w\[-])/g;
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
  const scale = typeScale(BRIEF);
  const radii = radiusScale(BRIEF);

  it("reads the scales from design/DESIGN.md", () => {
    expect(scale.size).toBe(8);
    expect(radii.get("rounded-lg")).toBe(8);
  });

  it("names every @keyframes in the Motion section", () => {
    const css = readFileSync(
      join(process.cwd(), "src/app/globals.css"),
      "utf8",
    );
    expect(missingKeyframes(css, section(BRIEF, "Motion"))).toEqual([]);
  });

  it("uses only sizes from the type scale in text-[Npx]", () => {
    expect(scan(TEXT_PX, (m) => !scale.has(Number(m[1])))).toEqual([]);
  });

  it("uses no arbitrary padding, margin, gap or space value", () => {
    expect(scan(ARBITRARY_SPACING)).toEqual([]);
  });

  it("uses no arbitrary radius, and only radii the brief lists", () => {
    expect(scan(ARBITRARY_RADIUS)).toEqual([]);
    const listed = new Set(radii.values());
    expect(
      scan(NAMED_RADIUS, (m) => !listed.has(TAILWIND_RADIUS[m[1]!]!)),
    ).toEqual([]);
  });

  it("uses no terracotta-cta utility (the --terracotta-cta variable is fine)", () => {
    expect(scan(OLD_CTA)).toEqual([]);
  });

  describe("matchers catch drift", () => {
    const hits = (re: RegExp, text: string) =>
      [...text.matchAll(re)].map((m) => m[0]);

    it("text size outside the scale", () => {
      const m = [..."text-[14px] text-[13px]".matchAll(TEXT_PX)];
      expect(
        m.filter((x) => !scale.has(Number(x[1]))).map((x) => x[0]),
      ).toEqual(["text-[14px]"]);
    });

    it("arbitrary spacing, with variants and rem", () => {
      expect(
        hits(
          ARBITRARY_SPACING,
          "gap-[5px] md:px-[1rem] -mt-[3px] gap-2 w-[5px]",
        ),
      ).toEqual(["gap-[5px]", "md:px-[1rem]", "-mt-[3px]"]);
    });

    it("arbitrary radius", () => {
      expect(
        hits(
          ARBITRARY_RADIUS,
          "rounded-[10px] hover:rounded-t-[3px] rounded-lg",
        ),
      ).toEqual(["rounded-[10px]", "hover:rounded-t-[3px]"]);
    });

    it("named radius not in the brief", () => {
      const listed = new Set(radii.values());
      const bad = [
        ..."rounded-lg rounded-2xl rounded-xs rounded".matchAll(NAMED_RADIUS),
      ]
        .filter((m) => !listed.has(TAILWIND_RADIUS[m[1]!]!))
        .map((m) => m[1]!);
      expect(bad).toEqual(["rounded-2xl", "rounded-xs"]);
    });

    it("keyframe missing from the Motion section", () => {
      expect(
        missingKeyframes(
          "@keyframes fooBar {} @keyframes clayPulse {}",
          "clayPulse 2s",
        ),
      ).toEqual(["fooBar"]);
    });

    it("fails loudly when a section is missing", () => {
      expect(() => section("# x\n## Type\n", "Motion")).toThrow(/Motion/);
      expect(() => typeScale("## Type\nnothing\n")).toThrow(/Type/);
    });
  });
});
