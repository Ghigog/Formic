import { describe, expect, it } from "vitest";
import { claimLabel, heldBy, runningConflict } from "./queue";

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

describe("heldBy", () => {
  const claim = (ticketId: string, projectId: string, fileScope: string[], ownerLogin: string | null = "alice") => ({
    ticketId,
    key: ticketId.toUpperCase(),
    projectId,
    ownerLogin,
    fileScope,
  });

  it("finds a claim on another board writing the same files", () => {
    const hers = claim("a", "p2", ["src/api"]);
    expect(heldBy({ id: "b", fileScope: ["src/api/router.ts"] }, [hers])).toBe(hers);
  });

  it("ignores disjoint scopes, an empty scope and the card's own claim", () => {
    const own = claim("b", "p1", ["src/ui"]);
    expect(heldBy({ id: "b", fileScope: ["src/ui"] }, [own, claim("a", "p2", ["src/api"])])).toBeNull();
    expect(heldBy({ id: "c", fileScope: [] }, [own])).toBeNull();
  });

  it("names a claim on another board by whose board it is", () => {
    expect(claimLabel(claim("a", "p1", ["x"]), "p1")).toBe("A");
    expect(claimLabel(claim("a", "p2", ["x"]), "p1")).toBe("A on @alice's board");
    expect(claimLabel(claim("a", "p2", ["x"], null), "p1")).toBe("A on another board");
  });
});
