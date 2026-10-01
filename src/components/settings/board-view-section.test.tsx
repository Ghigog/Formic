import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BoardViewSection } from "./board-view-section";
import { loadBoardView, saveBoardView } from "@/components/board/view-setting";
import { EMPTY_VIEW } from "@/components/board/view";

afterEach(() => window.localStorage.clear());

describe("BoardViewSection", () => {
  it("saves the search", async () => {
    render(<BoardViewSection />);
    await userEvent.setup().type(screen.getByLabelText("Search"), "ab");
    expect(loadBoardView().query).toBe("ab");
  });

  it("saves the sort", async () => {
    render(<BoardViewSection />);
    await userEvent.setup().selectOptions(screen.getByLabelText("Sort by"), "title");
    expect(loadBoardView().sort).toBe("title");
  });

  it("saves the type toggles", async () => {
    render(<BoardViewSection />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: "Bugs" }));
    await user.click(screen.getByRole("checkbox", { name: "Archived" }));
    expect(loadBoardView().types).toEqual(["bug", "archived"]);
    await user.click(screen.getByRole("checkbox", { name: "Bugs" }));
    expect(loadBoardView().types).toEqual(["archived"]);
  });

  it("saves collapse", async () => {
    render(<BoardViewSection />);
    await userEvent.setup().click(screen.getByRole("checkbox", { name: "Collapse all columns" }));
    expect(loadBoardView().collapsed).toBe(true);
  });

  it("shows the saved view and Clear resets it", async () => {
    saveBoardView({ ...EMPTY_VIEW, query: "x", sort: "title" });
    render(<BoardViewSection />);
    expect(await screen.findByLabelText("Search")).toHaveValue("x");
    await userEvent.setup().click(screen.getByRole("button", { name: "Clear" }));
    expect(loadBoardView()).toEqual(EMPTY_VIEW);
    expect(screen.getByLabelText("Search")).toHaveValue("");
  });
});
