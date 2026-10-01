import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { unseenProjects, useAssistantActivity } from "./use-assistant-activity";

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

describe("useAssistantActivity", () => {
  it("counts unseen answers elsewhere and remembers the active project's", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ active: { id: "b" }, projects }));
    const { result } = renderHook(() => useAssistantActivity());
    await waitFor(() => expect(result.current.count).toBe(1));
    expect(result.current.unseen).toEqual(["a"]);
    expect(JSON.parse(window.localStorage.getItem("formic.assistant-seen")!)).toEqual({ b: "m2" });
  });
});
