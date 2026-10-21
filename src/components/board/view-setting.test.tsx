import { afterEach, describe, expect, it } from "vitest";
import {
  BOARD_VIEW_KEY,
  COLUMN_VIEWS_KEY,
  loadBoardView,
  loadColumnViews,
  saveBoardView,
  saveColumnViews,
} from "./view-setting";
import { EMPTY_VIEW } from "./view";

afterEach(() => window.localStorage.clear());

describe("board view setting", () => {
  it("is the default view when nothing is saved", () => {
    expect(loadBoardView()).toEqual(EMPTY_VIEW);
  });

  it("round-trips a saved view", () => {
    const view = { query: "login", sort: "title" as const, types: ["bug" as const], collapsed: true };
    saveBoardView(view);
    expect(loadBoardView()).toEqual(view);
  });

  it("falls back to the default view on corrupt JSON or a non-object", () => {
    window.localStorage.setItem(BOARD_VIEW_KEY, "{nope");
    expect(loadBoardView()).toEqual(EMPTY_VIEW);
    window.localStorage.setItem(BOARD_VIEW_KEY, "42");
    expect(loadBoardView()).toEqual(EMPTY_VIEW);
  });

  it("drops unknown sorts and types", () => {
    window.localStorage.setItem(
      BOARD_VIEW_KEY,
      JSON.stringify({ query: "x", sort: "weird", types: ["bug", "epic"], collapsed: "yes" }),
    );
    expect(loadBoardView()).toEqual({ query: "x", sort: "position", types: ["bug"], collapsed: false });
  });
});

describe("column views setting", () => {
  const all = (v: typeof EMPTY_VIEW) => ({ backlog: v, todo: v, in_progress: v, in_review: v, done: v });

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
