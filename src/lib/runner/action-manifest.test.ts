import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("the runner Action's manifest", () => {
  it("runs on a runtime GitHub's runners support", () => {
    const text = readFileSync(path.join(process.cwd(), "runner-action/action.yml"), "utf8");
    const using = /^\s+using:\s*(\S+)/m.exec(text)?.[1];
    // GitHub refuses any other value ("using: node22 is not supported") and the job fails before it starts.
    expect(["node20", "node24"]).toContain(using);
  });
});
