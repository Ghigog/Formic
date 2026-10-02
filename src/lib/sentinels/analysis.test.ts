import { describe, expect, it } from "vitest";
import {
  a11yEvidence,
  aliasesFrom,
  contrast,
  contrastEvidence,
  importEvidence,
  importGraph,
  jsonc,
  outline,
  tags,
  untestedEvidence,
} from "./analysis";

const repo = new Map<string, string>([
  ["tsconfig.json", '{\n  // paths\n  "compilerOptions": { "paths": { "@/*": ["./src/*"] }, },\n}'],
  ["src/lib/a.ts", 'import { b } from "./b";\nimport x from "@/lib/c";\nimport "react";\nexport const a = b + x;\n'],
  ["src/lib/b.ts", 'export { c } from "@/lib/c.js";\nexport const b = 1;\n'],
  ["src/lib/c.ts", "export default 2;\n"],
  ["src/ui/view.tsx", 'import { a } from "../lib/a";\nexport const View = () => a;\n'],
  ["src/lib/loop.ts", 'import { View } from "@/ui/view";\nexport const loop = View;\n'],
  ["src/lib/a.test.ts", 'import { a } from "./a";\n'],
]);

describe("jsonc", () => {
  it("drops comments and trailing commas but keeps a path that looks like one", () => {
    expect(JSON.parse(jsonc('{ "a": "@/*", /* c */ "b": [1,], // d\n }'))).toEqual({ a: "@/*", b: [1] });
  });
});

describe("importGraph", () => {
  const graph = importGraph(repo, aliasesFrom(repo.get("tsconfig.json")));

  it("resolves relative paths, aliases and ESM .js names, and leaves packages out", () => {
    expect([...graph.get("src/lib/a.ts")!].sort()).toEqual(["src/lib/b.ts", "src/lib/c.ts"]);
    expect([...graph.get("src/lib/b.ts")!]).toEqual(["src/lib/c.ts"]);
  });

  it("maps folders and finds the cycle between them", () => {
    const text = importEvidence(repo, graph);
    expect(text).toContain("- src/lib -> src/ui: 1");
    expect(text).toContain("- src/ui -> src/lib: 1");
    expect(text).toContain("- src/lib <-> src/ui");
    expect(text).toContain("- src/lib/c.ts: imported by 2");
  });

  it("lists source no test names or imports", () => {
    const text = untestedEvidence([...repo.keys()], repo, graph);
    expect(text).toContain("1 test files; 5 source files, of which 4 are neither");
    expect(text).not.toContain("src/lib/a.ts");
    expect(text).toContain("- src/lib/loop.ts: 2 lines");
  });
});

describe("tags", () => {
  it("reads past arrows and objects inside props", () => {
    const [t] = tags('<div onClick={() => go({ a: 1 > 0 })} className="x">hi</div>');
    expect(t).toMatchObject({ name: "div", inner: "hi", line: 1 });
    expect(t!.attrs).toContain('className="x"');
  });
});

describe("a11yEvidence", () => {
  it("finds what a pattern can, with where", () => {
    const text = a11yEvidence(
      new Map([
        [
          "src/app/page.tsx",
          [
            '<img src="a.png" />',
            "<div onClick={open}>Open</div>",
            '<div role="button" onClick={open} onKeyDown={key}>Fine</div>',
            "<button><svg /></button>",
            '<button aria-label="Close"><svg /></button>',
            "<input value={v} />",
            "<a onClick={go}>Go</a>",
          ].join("\n"),
        ],
        ["design/mock.html", "<img src=x>"],
      ]),
    );
    expect(text).toContain("- image with no alt: 1 (src/app/page.tsx:1)");
    expect(text).toContain("no role or key handler: 1 (src/app/page.tsx:2)");
    expect(text).toContain("- button with no text and no accessible name: 1 (src/app/page.tsx:4)");
    expect(text).toContain("aria-labelledby to name it: 1 (src/app/page.tsx:6)");
    expect(text).toContain("- link with a click handler and no href: 1 (src/app/page.tsx:7)");
    expect(text).toContain("reduced-motion handling: none found");
  });
});

describe("contrast", () => {
  it("matches WCAG's figures", () => {
    expect(contrast("#000", "#fff")).toBeCloseTo(21, 0);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
  });

  it("checks the pairs one element uses, in every theme", () => {
    const css = `
      :root { --ink: #1c1917; --muted: #a8a29e; --card: #ffffff; }
      :root[data-theme="dark"] { --ink: #f5f1ea; --card: #1c1917; }
      @theme inline { --color-ink: var(--ink); --color-muted: var(--muted); --color-card: var(--card); }
      .note { color: var(--muted); background: var(--card); }
    `;
    const text = contrastEvidence([["app.css", css]], [["a.tsx", '<p className="text-ink bg-card p-2" />']])!;
    expect(text).toContain("Contrast of 2 colour pairs");
    expect(text).toMatch(/--muted #a8a29e on --card #ffffff: 2\.\d\d:1 \(e\.g\. app\.css \(\.note\)\)/);
    expect(text).toContain("Every pair clears 4.5:1 in the dark");
  });
});

describe("outline", () => {
  it("lists the declarations after a line, not the statements", () => {
    const text = "const a = 1;\nexport function b() {\n  if (a) {\n  }\n  method(x: number): void {\n}\nclass C {}\n";
    expect(outline(text, 1)).toEqual(["2: export function b() {", "5: method(x: number): void {", "7: class C {}"]);
  });
});
