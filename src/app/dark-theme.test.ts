import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "globals.css"), "utf8");
const brief = readFileSync(join(__dirname, "../../design/DESIGN.md"), "utf8");

const block = /:root\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
const dark = new Map<string, string>(
  [...block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1] as string, (m[2] as string).toLowerCase()] as const),
);

const section = /## Dark theme\n([\s\S]*?)\n## /.exec(brief)?.[1] ?? "";
const documented = new Map<string, string>(
  [...section.matchAll(/^(--[\w-]+)\s+(#[0-9a-fA-F]{6})\b/gm)].map((m) => [m[1] as string, (m[2] as string).toLowerCase()] as const),
);

function luminance(hex: string) {
  const [r = 0, g = 0, b = 0] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const get = (token: string) => dark.get(token) as string;

describe("dark theme", () => {
  it("parses the dark block", () => {
    expect(dark.size).toBeGreaterThan(20);
  });

  it("is no longer called derived", () => {
    expect(css).not.toContain("derived, not designed");
  });

  it.each(["--cream", "--column", "--panel", "--card", "--nested", "--nested-muted"])(
    "text-muted reads at 4.5:1 on %s",
    (surface) => {
      expect(contrast(get("--text-muted"), get(surface))).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each([...dark.keys()].filter((k) => k.endsWith("-chip-text")))(
    "%s reads at 4.5:1 on its chip",
    (token) => {
      const chip = token.replace("-text", "");
      expect(dark.has(chip)).toBe(true);
      expect(contrast(get(token), get(chip))).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("is listed in DESIGN.md with matching values", () => {
    expect(Object.fromEntries(documented)).toEqual(Object.fromEntries(dark));
  });
});
