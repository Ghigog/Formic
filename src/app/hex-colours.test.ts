import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const DIRS = ["src/components", "src/app"];
const HEX = /#[0-9a-fA-F]{6}\b/;
const SVG_PAINT = /fill=|stroke=|stopColor=/;

/** Lines that write a raw 6-digit hex outside an SVG fill, stroke or stopColor attribute. */
function hexLines(source: string): { line: number; text: string }[] {
  return source
    .split("\n")
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => HEX.test(text) && !SVG_PAINT.test(text));
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return tsxFiles(path);
    return e.name.endsWith(".tsx") && !path.includes("test") ? [path] : [];
  });
}

describe("hex colours in component files", () => {
  it("fails on an exported hex constant", () => {
    expect(hexLines('export const GUIDE_ANT_HEX = "#a1b2c3";\n')).toEqual([
      { line: 1, text: 'export const GUIDE_ANT_HEX = "#a1b2c3";' },
    ]);
  });

  it("allows hex in an SVG fill, stroke or stopColor", () => {
    expect(hexLines('<path fill="#a1b2c3" />\n<stop stopColor="#a1b2c3" />')).toEqual([]);
  });

  it("finds none in src/components or src/app", () => {
    const found = DIRS.flatMap((d) => tsxFiles(join(ROOT, d))).flatMap((file) =>
      hexLines(readFileSync(file, "utf8")).map((l) => `${relative(ROOT, file)}:${l.line}: ${l.text.trim()}`),
    );
    expect(found).toEqual([]);
  });
});
