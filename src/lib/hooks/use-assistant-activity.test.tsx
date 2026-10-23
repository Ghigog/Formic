import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { markSeen, unseenProjects, useAssistantActivity, waitingOn } from "./use-assistant-activity";

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const projects = [
  { id: "a", lastAssistantMessage: { id: "m1" } },
  { id: "b", lastAssistantMessage: { id: "m2" } },
  { id: "c", lastAssistantMessage: null },
];

describe("unseenProjects", () => {
  it("counts other projects with an unseen answer, never the active one", () => {
    expect(unseenProjects(projects, "b", {})).toEqual(["a"]);
    expect(unseenProjects(projects, "b", { a: "m1" })).toEqual([]);
    expect(unseenProjects(projects, "b", { a: "old" })).toEqual(["a"]);
  });
});

describe("notifications", () => {
  const moved = { id: "a", notifications: { ticketMoved: { seq: 5 }, needsAttention: { seq: 7 } } };

  it("counts a kind whose latest event is newer than the one seen", () => {
    expect(unseenProjects([moved], "z", {})).toEqual(["a"]);
    expect(waitingOn(moved, {}, { a: { ticketMoved: 5 } })).toEqual(["needsAttention"]);
    expect(unseenProjects([moved], "z", {}, { a: { ticketMoved: 5, needsAttention: 7 } })).toEqual([]);
  });

  it("stops counting a board once it is marked seen", () => {
    markSeen(moved);
    expect(
      unseenProjects([moved], "z", {}, JSON.parse(window.localStorage.getItem("formic.notifications-seen")!)),
    ).toEqual([]);
  });

  it("counts a moved ticket on another board until that board is opened", async () => {
    const other = { id: "a", notifications: { ticketMoved: { seq: 3 } } };
    vi.stubGlobal("fetch", async () => Response.json({ active: { id: "b" }, projects: [other, { id: "b" }] }));
    const { result } = renderHook(() => useAssistantActivity());
    await waitFor(() => expect(result.current.unseen).toEqual(["a"]));
    markSeen(other);
    const again = renderHook(() => useAssistantActivity());
    await waitFor(() => expect(again.result.current.count).toBe(0));
  });
});

describe("useAssistantActivity", () => {
  it("counts unseen answers elsewhere and remembers the active project's", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ active: { id: "b" }, projects }));
    const { result } = renderHook(() => useAssistantActivity());
    await waitFor(() => expect(result.current.count).toBe(1));
    expect(result.current.unseen).toEqual(["a"]);
    expect(JSON.parse(window.localStorage.getItem("formic.assistant-seen")!)).toEqual({ b: "m2" });
  });
});
