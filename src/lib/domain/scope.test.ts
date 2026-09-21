import { describe, expect, it } from "vitest";
import {
  ScopeError,
  containsPath,
  normalizeScope,
  normalizeScopePath,
  pathInScope,
  scopesOverlap,
  touchesSharedSurface,
  violationsInDiff,
} from "./scope";

describe("normalizeScopePath", () => {
  it("strips leading, trailing and duplicate separators", () => {
    expect(normalizeScopePath("/src/components/")).toBe("src/components");
    expect(normalizeScopePath("src//components")).toBe("src/components");
    expect(normalizeScopePath("./src/components")).toBe("src/components");
  });

  it("reduces trailing wildcards to the directory prefix", () => {
    expect(normalizeScopePath("src/components/**")).toBe("src/components");
    expect(normalizeScopePath("src/components/*")).toBe("src/components");
  });

  it("refuses to escape the repository", () => {
    expect(() => normalizeScopePath("../secrets")).toThrow(ScopeError);
    expect(() => normalizeScopePath("src/../../etc")).toThrow(ScopeError);
  });

  it("refuses a scope covering the whole repository", () => {
    expect(() => normalizeScopePath("/")).toThrow(ScopeError);
    expect(() => normalizeScopePath("**")).toThrow(ScopeError);
    expect(() => normalizeScopePath("")).toThrow(ScopeError);
  });
});

describe("normalizeScope", () => {
  it("drops entries already covered by a broader sibling", () => {
    expect(normalizeScope(["src", "src/ui", "src/ui/button"])).toEqual(["src"]);
  });

  it("keeps genuinely disjoint entries and sorts them", () => {
    expect(normalizeScope(["src/ui", "prisma"])).toEqual(["prisma", "src/ui"]);
  });

  it("de-duplicates", () => {
    expect(normalizeScope(["src/ui", "src/ui/"])).toEqual(["src/ui"]);
  });
});

describe("containsPath", () => {
  it("respects segment boundaries", () => {
    expect(containsPath("src/comp", "src/components")).toBe(false);
    expect(containsPath("src/components", "src/components/ui")).toBe(true);
    expect(containsPath("src/components", "src/components")).toBe(true);
  });
});

describe("scopesOverlap", () => {
  it("is false for sibling directories", () => {
    expect(scopesOverlap(["src/components/ui"], ["src/components/board"])).toBe(
      false,
    );
  });

  it("is true when one contains the other", () => {
    expect(scopesOverlap(["src/components"], ["src/components/ui"])).toBe(true);
  });

  it("is not fooled by a shared string prefix", () => {
    expect(scopesOverlap(["src/lib/db"], ["src/lib/dbx"])).toBe(false);
  });
});

describe("touchesSharedSurface", () => {
  it("flags a scope that swallows package.json", () => {
    expect(touchesSharedSurface(["package.json"])).toContain("package.json");
  });

  it("flags a scope containing the prisma schema", () => {
    expect(touchesSharedSurface(["prisma"])).toContain("prisma/schema.prisma");
  });

  it("is empty for an isolated component directory", () => {
    expect(touchesSharedSurface(["src/components/ui"])).toEqual([]);
  });
});

describe("diff enforcement", () => {
  const scope = ["src/components/ui", "src/lib/format"];

  it("accepts a file inside the scope", () => {
    expect(pathInScope("src/components/ui/button.tsx", scope)).toBe(true);
  });

  it("rejects a file outside it", () => {
    expect(pathInScope("src/app/page.tsx", scope)).toBe(false);
  });

  it("reports every violating path in a diff", () => {
    const changed = [
      "src/components/ui/button.tsx",
      "src/app/page.tsx",
      "package.json",
    ];
    expect(violationsInDiff(changed, scope)).toEqual([
      "src/app/page.tsx",
      "package.json",
    ]);
  });

  it("passes a clean diff", () => {
    expect(violationsInDiff(["src/lib/format/date.ts"], scope)).toEqual([]);
  });
});
