import { describe, expect, it } from "vitest";
import { layoutLines } from "./repositories";

describe("a repository's layout, for the Architect Agent", () => {
  it("lists each directory's files on one line, leaving out what no scope names", () => {
    expect(
      layoutLines([
        "package.json",
        "src/lib/auth/session.ts",
        "src/lib/auth/session.test.ts",
        "src/lib/auth/crypto.ts",
        "public/logo.png",
        "node_modules/react/index.js",
        "dist/app.js",
      ]),
    ).toEqual(["./: package.json", "src/lib/auth/: crypto.ts session.test.ts session.ts"]);
  });

  it("lists a crowded directory in part, and stops before the prompt grows too long", () => {
    const crowded = Array.from({ length: 50 }, (_, i) => `src/icons/icon${String(i).padStart(2, "0")}.tsx`);
    expect(layoutLines(crowded)[0]).toMatch(/icon39\.tsx \(and 10 more\)$/);

    const many = Array.from({ length: 5_000 }, (_, i) => `src/module${i}/index.ts`);
    const lines = layoutLines(many);
    expect(lines.join("\n").length).toBeLessThan(33_000);
    expect(lines.at(-1)).toMatch(/^\(\d+ more directories not shown\)$/);
  });
});
