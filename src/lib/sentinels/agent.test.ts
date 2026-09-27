import { describe, expect, it } from "vitest";
import { candidateFiles } from "./agent";
import { sentinel } from "./roster";

describe("candidateFiles", () => {
  const all = [
    "README.md",
    "package-lock.json",
    "node_modules/x/index.js",
    "public/logo.png",
    "src/app/page.tsx",
    "src/lib/auth/session.ts",
    "src/lib/auth/session.test.ts",
  ];

  it("drops lockfiles, dependencies and binaries", () => {
    const files = candidateFiles(all, sentinel("architect")!);
    expect(files).not.toContain("package-lock.json");
    expect(files).not.toContain("node_modules/x/index.js");
    expect(files).not.toContain("public/logo.png");
    expect(files).toContain("src/app/page.tsx");
  });

  it("puts what the role reads for first", () => {
    expect(candidateFiles(all, sentinel("tester")!)[0]).toBe("src/lib/auth/session.test.ts");
    expect(candidateFiles(all, sentinel("secops")!).slice(0, 2).sort()).toEqual([
      "src/lib/auth/session.test.ts",
      "src/lib/auth/session.ts",
    ]);
  });
});
