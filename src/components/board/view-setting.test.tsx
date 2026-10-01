import { afterEach, describe, expect, it } from "vitest";
import { BOARD_VIEW_KEY, loadBoardView, saveBoardView } from "./view-setting";
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
