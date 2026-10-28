import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const sendPush = vi.fn();
vi.mock("@/lib/push/send", () => ({ sendPush: (...a: unknown[]) => sendPush(...a) }));
let prefs = { ticketMoved: true, epicCompleted: true, needsAttention: true };
const card = { key: "T-5", title: "Add login" };
vi.mock("@/lib/db", () => ({
  repository: () => ({
    projectById: async () => ({ ownerId: "u1", name: "Formic" }),
    cardById: async () => card,
    pushPreferences: async () => prefs,
  }),
}));

import type { FormicEvent } from "@/lib/domain/events";
import { notifyOwner } from "./notify";

let cards = 0;
const status = (s: string, kind = "ticket", cardId = `c${cards++}`) =>
  ({ type: "card.status", cardId, kind, status: s, stalledIn: null, stage: 3, blockedReason: null }) as FormicEvent;

describe("notifyOwner", () => {
  beforeEach(() => {
    sendPush.mockReset();
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
});
