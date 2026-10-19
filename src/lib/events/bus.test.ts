import { describe, expect, it } from "vitest";
import type { FormicEvent } from "@/lib/domain/events";
import { movesQueens } from "@/lib/events/bus";

const status = (s: string, kind = "ticket") => ({ type: "card.status", cardId: "c", kind, status: s }) as unknown as FormicEvent;

describe("movesQueens", () => {
  it("moves on merge, review, and a ticket returning to To Do", () => {
    for (const s of ["merged", "review", "ready", "waiting"]) expect(movesQueens(status(s))).toBe(true);
  });

  it("does not move while a ticket runs, blocks or fails", () => {
    for (const s of ["running", "blocked", "failed"]) expect(movesQueens(status(s))).toBe(false);
  });
});
