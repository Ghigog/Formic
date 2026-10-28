import { afterEach, describe, expect, it } from "vitest";
import {
  COLLAPSED_EPICS_KEY,
  emptyCollapsedEpics,
  loadCollapsedEpics,
  saveCollapsedEpics,
} from "./collapsed-epics";

afterEach(() => window.localStorage.clear());

describe("collapsed epics setting", () => {
  it("is all expanded when nothing is saved", () => {
    expect(loadCollapsedEpics()).toEqual(emptyCollapsedEpics());
  });

  it("round-trips the collapsed epics of each column", () => {
    const saved = { ...emptyCollapsedEpics(), todo: new Set(["a", "b"]), done: new Set(["c"]) };
    saveCollapsedEpics(saved);
    expect(loadCollapsedEpics()).toEqual(saved);
  });

  it("is all expanded on corrupt JSON or a non-object", () => {
    window.localStorage.setItem(COLLAPSED_EPICS_KEY, "{nope");
    expect(loadCollapsedEpics()).toEqual(emptyCollapsedEpics());
    window.localStorage.setItem(COLLAPSED_EPICS_KEY, "42");
    expect(loadCollapsedEpics()).toEqual(emptyCollapsedEpics());
  });

  it("ignores entries that are not epic ids", () => {
    window.localStorage.setItem(COLLAPSED_EPICS_KEY, JSON.stringify({ todo: ["a", 7, null], done: "x" }));
    expect(loadCollapsedEpics()).toEqual({ ...emptyCollapsedEpics(), todo: new Set(["a"]) });
  });
});
