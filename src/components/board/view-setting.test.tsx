import { afterEach, describe, expect, it } from "vitest";
import { COLUMN_VIEWS_KEY, loadColumnViews, saveColumnViews } from "./view-setting";
import { EMPTY_VIEW } from "./view";

afterEach(() => window.localStorage.clear());

describe("column views setting", () => {
  const all = (v: typeof EMPTY_VIEW) => ({ backlog: v, todo: v, in_progress: v, in_review: v, done: v });

  it("removes the retired board-wide view on load", () => {
    window.localStorage.setItem("formic:board-view:v1", "{}");
    loadColumnViews();
    expect(window.localStorage.getItem("formic:board-view:v1")).toBeNull();
  });

  it("is empty when nothing is saved", () => {
    expect(loadColumnViews()).toEqual({});
  });

  it("round-trips the saved views", () => {
    const bugs = { query: "x", sort: "newest" as const, types: ["bug" as const], collapsed: true };
    const views = { ...all(EMPTY_VIEW), done: bugs };
    saveColumnViews(views);
    expect(loadColumnViews()).toEqual(views);
  });

  it("is empty on corrupt JSON or a non-object", () => {
    window.localStorage.setItem(COLUMN_VIEWS_KEY, "{nope");
    expect(loadColumnViews()).toEqual({});
    window.localStorage.setItem(COLUMN_VIEWS_KEY, "[1]");
    expect(loadColumnViews()).toEqual({});
    window.localStorage.setItem(COLUMN_VIEWS_KEY, "42");
    expect(loadColumnViews()).toEqual({});
  });

  it("keeps a partial map partial, validating each field and ignoring unknown columns", () => {
    window.localStorage.setItem(
      COLUMN_VIEWS_KEY,
      JSON.stringify({ done: { sort: "weird", types: ["bug", "epic"] }, todo: 7, nope: { query: "x" } }),
    );
    expect(loadColumnViews()).toEqual({
      done: { ...EMPTY_VIEW, types: ["bug"] },
      todo: EMPTY_VIEW,
    });
  });
});
