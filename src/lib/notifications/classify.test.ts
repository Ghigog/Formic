import { describe, expect, it } from "vitest";
import type { FormicEvent } from "@/lib/domain/events";
import { classifyEvent } from "./classify";

const ctx = { cardKey: "T-5", cardTitle: "Add login", boardName: "Formic" };
const status = (s: string, kind: "ticket" | "epic" = "ticket", blockedReason: string | null = null) =>
  ({ type: "card.status", cardId: "c", kind, status: s, stalledIn: null, stage: 3, blockedReason }) as FormicEvent;

describe("classifyEvent", () => {
  it("says which ticket moved to which column", () => {
    const n = classifyEvent(status("review"), ctx);
    expect(n?.kind).toBe("ticketMoved");
    expect(n?.body).toBe("T-5 on Formic moved to In Review");
  });

  it("says an Epic completed when it reaches Done", () => {
    const n = classifyEvent(status("merged", "epic"), { ...ctx, cardKey: "E-1", cardTitle: "Login" });
    expect(n?.kind).toBe("epicCompleted");
    expect(n?.body).toContain("Login");
  });

  it("does not notify for an Epic still moving", () => {
    expect(classifyEvent(status("ready", "epic"), ctx)).toBeNull();
  });

  it("flags a failed or blocked ticket as needing attention, not as moved", () => {
    expect(classifyEvent(status("failed"), ctx)?.kind).toBe("needsAttention");
    expect(classifyEvent(status("blocked", "ticket", "Needs a key"), ctx)?.body).toBe("Needs a key");
  });

  it("flags an exhausted budget as needing attention", () => {
    const e = { type: "budget.exhausted", scope: "run", id: "r", detail: "Out of budget" } as FormicEvent;
    expect(classifyEvent(e, ctx)?.kind).toBe("needsAttention");
  });

  it("ignores events that are not worth a push", () => {
    expect(classifyEvent({ type: "runner.ready" }, ctx)).toBeNull();
  });
});
