import { describe, expect, it } from "vitest";
import { runningConflict } from "./queue";

const card = (id: string, status: "running" | "queued" | "review" | "ready", fileScope: string[]) => ({
  id,
  status,
  fileScope,
});

describe("runningConflict", () => {
  it("finds the running card writing the same files", () => {
    const a = card("a", "running", ["src/ui"]);
    expect(runningConflict(card("b", "ready", ["src/ui/button.tsx"]), [a])).toBe(a);
  });

  it("ignores cards that are not running", () => {
    const others = [card("a", "review", ["src/ui"]), card("c", "queued", ["src/ui"])];
    expect(runningConflict(card("b", "ready", ["src/ui"]), others)).toBeNull();
  });

  it("ignores disjoint scopes, empty scopes and the card itself", () => {
    const b = card("b", "running", ["src/ui"]);
    expect(runningConflict(b, [b, card("a", "running", ["src/api"])])).toBeNull();
    expect(runningConflict(card("c", "ready", []), [b])).toBeNull();
  });
});
