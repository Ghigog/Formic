import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderInDnd } from "@/test/render";
import { ViewMenu } from "./view-menu";
import { EMPTY_VIEW, type ColumnView } from "./view";

describe("ViewMenu", () => {
  it("renders button with correct aria-label and opens on click", () => {
    const onChange = vi.fn();
    renderInDnd(<ViewMenu value={EMPTY_VIEW} onChange={onChange} scope="column" />);

    const button = screen.getByRole("button", { name: "Column options" });
    expect(button).toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(button);
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("emits onChange when search query changes", () => {
    const onChange = vi.fn();
    renderInDnd(<ViewMenu value={EMPTY_VIEW} onChange={onChange} scope="column" />);

    fireEvent.click(screen.getByRole("button", { name: "Column options" }));
    const input = screen.getByPlaceholderText("Search key or title...");
    fireEvent.change(input, { target: { value: "login" } });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ query: "login" })
    );
  });

  it("emits onChange when sort option is chosen", () => {
    const onChange = vi.fn();
    renderInDnd(<ViewMenu value={EMPTY_VIEW} onChange={onChange} scope="column" />);

    fireEvent.click(screen.getByRole("button", { name: "Column options" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Title/i }));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ sort: "title" })
    );
  });

  it("shows four unchecked type toggles by default", () => {
    renderInDnd(<ViewMenu value={EMPTY_VIEW} onChange={vi.fn()} scope="column" />);
    fireEvent.click(screen.getByRole("button", { name: "Column options" }));
    for (const name of ["Tickets", "Bugs", "Spikes", "Archived"]) {
      expect(screen.getByRole("menuitemcheckbox", { name })).toHaveAttribute("aria-checked", "false");
    }
  });

  it("toggles types independently", () => {
    const onChange = vi.fn();
    renderInDnd(<ViewMenu value={{ ...EMPTY_VIEW, types: ["bug"] }} onChange={onChange} scope="column" />);
    fireEvent.click(screen.getByRole("button", { name: "Column options" }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Bugs" })).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Spikes" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ types: ["bug", "spike"] }));

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Bugs" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ types: [] }));
  });

  it("emits onChange when collapse/expand is clicked", () => {
    const onChange = vi.fn();
    renderInDnd(<ViewMenu value={EMPTY_VIEW} onChange={onChange} scope="column" />);

    fireEvent.click(screen.getByRole("button", { name: "Column options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Collapse column" }));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ collapsed: true })
    );
  });

  it("Clear reverts to EMPTY_VIEW when view is active", () => {
    const onChange = vi.fn();
    const activeView: ColumnView = {
      query: "login",
      sort: "title",
      types: ["bug"],
      collapsed: true,
    };
    renderInDnd(<ViewMenu value={activeView} onChange={onChange} scope="column" />);

    fireEvent.click(screen.getByRole("button", { name: "Column options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear" }));

    expect(onChange).toHaveBeenCalledWith(EMPTY_VIEW);
  });

  it("closes on Escape key", () => {
    const onChange = vi.fn();
    renderInDnd(<ViewMenu value={EMPTY_VIEW} onChange={onChange} scope="board" />);

    const button = screen.getByRole("button", { name: "Board options" });
    fireEvent.click(button);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
