import { describe, expect, it } from "vitest";

import {
  MemoryWorkspace,
  safeRelativePath,
  scopedWorkspace,
} from "./workspace";
import { ScopeError } from "@/lib/domain/scope";

describe("safeRelativePath", () => {
  it("accepts an ordinary relative path", () => {
    expect(safeRelativePath("src/lib/thing.ts")).toBe("src/lib/thing.ts");
    expect(safeRelativePath("./src/lib/thing.ts")).toBe("src/lib/thing.ts");
  });

  it("refuses to climb out of the checkout", () => {
    expect(() => safeRelativePath("../../etc/passwd")).toThrow(ScopeError);
    expect(() => safeRelativePath("src/../../outside")).toThrow(ScopeError);
  });

  it("refuses an absolute path", () => {
    expect(() => safeRelativePath("/etc/passwd")).toThrow(ScopeError);
  });
});

describe("scopedWorkspace", () => {
  const scope = ["src/lib/feature", "docs"];

  it("allows a write inside the scope", async () => {
    const memory = new MemoryWorkspace();
    const scoped = scopedWorkspace(memory, scope);

    await scoped.writeFile("src/lib/feature/thing.ts", "export const a = 1;");

    expect(await memory.changedFiles()).toEqual(["src/lib/feature/thing.ts"]);
  });

  it("rejects a write outside the scope, and says which paths were allowed", async () => {
    const memory = new MemoryWorkspace();
    const scoped = scopedWorkspace(memory, scope);

    await expect(
      scoped.writeFile("src/app/page.tsx", "export default null;"),
    ).rejects.toThrow(/outside this ticket's file scope/);

    // The rejection has to happen before the write, not after it.
    expect(await memory.changedFiles()).toEqual([]);
  });

  it("rejects a traversal dressed up as an in-scope path", async () => {
    const memory = new MemoryWorkspace();
    const scoped = scopedWorkspace(memory, scope);

    await expect(
      scoped.writeFile("src/lib/feature/../../app/page.tsx", "x"),
    ).rejects.toThrow(ScopeError);
  });

  it("leaves reads unrestricted", async () => {
    const memory = new MemoryWorkspace({ "src/app/page.tsx": "hello" });
    const scoped = scopedWorkspace(memory, scope);

    // An agent has to be able to read the code it is fitting into; the scope
    // is a write boundary, not a visibility one.
    expect(await scoped.readFile("src/app/page.tsx")).toBe("hello");
  });
});
