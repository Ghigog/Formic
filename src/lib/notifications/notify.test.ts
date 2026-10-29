import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const sendPush = vi.fn();
vi.mock("@/lib/push/send", () => ({ sendPush: (...a: unknown[]) => sendPush(...a) }));
let prefs = { ticketMoved: true, epicCompleted: true, needsAttention: true };
const card = { key: "T-5", title: "Add login" };
let previous: unknown = null;
vi.mock("@/lib/db", () => ({
  repository: () => ({
    projectById: async () => ({ ownerId: "u1", name: "Formic" }),
    cardById: async () => card,
    pushPreferences: async () => prefs,
    cardStatusBefore: async () => previous,
  }),
}));

import type { FormicEvent } from "@/lib/domain/events";
import { notifyOwner, resetNotified } from "./notify";

let cards = 0;
const status = (s: string, kind = "ticket", cardId = `c${cards++}`) =>
  ({ type: "card.status", cardId, kind, status: s, stalledIn: null, stage: 3, blockedReason: null }) as FormicEvent;

describe("notifyOwner", () => {
  beforeEach(() => {
    sendPush.mockReset();
    resetNotified();
    previous = null;
    prefs = { ticketMoved: true, epicCompleted: true, needsAttention: true };
  });

  it("pushes a move to the board owner when the kind is on", async () => {
    await notifyOwner("p", status("review"));
    expect(sendPush).toHaveBeenCalledWith("u1", expect.objectContaining({ body: "T-5 on Formic moved to In Review" }));
  });

  it("sends nothing when the kind is switched off", async () => {
    prefs.needsAttention = false;
    await notifyOwner("p", status("failed"));
    expect(sendPush).not.toHaveBeenCalled();
  });

  it("does not throw when the push fails", async () => {
    sendPush.mockRejectedValue(new Error("boom"));
    await expect(notifyOwner("p", status("review"))).resolves.toBeUndefined();
  });

  it("pushes one move when a ticket goes queued then running, both In Progress", async () => {
    await notifyOwner("p", status("queued", "ticket", "same"));
    await notifyOwner("p", status("running", "ticket", "same"));
    await notifyOwner("p", status("running", "ticket", "same"));
    expect(sendPush).toHaveBeenCalledTimes(1);
  });

  it("pushes again when the ticket reaches another column", async () => {
    await notifyOwner("p", status("running", "ticket", "moves"));
    await notifyOwner("p", status("review", "ticket", "moves"));
    expect(sendPush).toHaveBeenCalledTimes(2);
  });

  it("still pushes attention for a ticket that stalls where it is", async () => {
    await notifyOwner("p", status("running", "ticket", "stalls"));
    await notifyOwner("p", { ...status("failed", "ticket", "stalls"), stalledIn: "in_progress" } as FormicEvent);
    expect(sendPush).toHaveBeenCalledTimes(2);
    expect(sendPush).toHaveBeenLastCalledWith("u1", expect.objectContaining({ title: expect.stringContaining("needs your attention") }));
  });

  it("pushes attention once for a ticket stopped again for the same reason", async () => {
    const stuck = { ...status("blocked", "ticket", "parked"), stalledIn: "in_review", blockedReason: "Needs a human." };
    await notifyOwner("p", stuck as FormicEvent);
    await notifyOwner("p", stuck as FormicEvent);
    expect(sendPush).toHaveBeenCalledTimes(1);

    await notifyOwner("p", { ...stuck, blockedReason: "Another reason." } as FormicEvent);
    expect(sendPush).toHaveBeenCalledTimes(2);
  });

  it("pushes a finished Epic once", async () => {
    await notifyOwner("p", status("merged", "epic", "epic"));
    await notifyOwner("p", status("merged", "epic", "epic"));
    expect(sendPush).toHaveBeenCalledTimes(1);
  });

  it("pushes one alert when an Epic's stop stops each of its runs", async () => {
    const stop = (id: string) =>
      ({ type: "budget.exhausted", scope: "epic", id, detail: "The Epic reached its budget." }) as FormicEvent;
    await notifyOwner("p", stop("run1"));
    await notifyOwner("p", stop("run2"));
    await notifyOwner("p", stop("run3"));
    expect(sendPush).toHaveBeenCalledTimes(1);
  });

  it("reads where a card was from the event log after a restart", async () => {
    previous = status("queued", "ticket", "restarted");
    await notifyOwner("p", status("running", "ticket", "restarted"), 42);
    expect(sendPush).not.toHaveBeenCalled();
  });

  it("pushes a card's first status when the log has nothing before it", async () => {
    await notifyOwner("p", status("review", "ticket", "fresh"), 42);
    expect(sendPush).toHaveBeenCalledTimes(1);
  });
});
