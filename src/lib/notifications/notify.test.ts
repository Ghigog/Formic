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

const status = (s: string, kind = "ticket") =>
  ({ type: "card.status", cardId: "c", kind, status: s, stalledIn: null, stage: 3, blockedReason: null }) as FormicEvent;

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
});
