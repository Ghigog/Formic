import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BoardFilterBar } from "./board-filter-bar";
import { EMPTY_VIEW, type ColumnView } from "./view";

function Harness({ onChange }: { onChange: (v: ColumnView) => void }) {
  const [view, setView] = useState<ColumnView>(EMPTY_VIEW);
  return (
    <BoardFilterBar
      value={view}
      onChange={(v) => {
        setView(v);
        onChange(v);
      }}
    />
  );
}

describe("BoardFilterBar", () => {
  it("reports each keystroke as a new query", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("Filter cards"), "so");
    expect(onChange.mock.calls.map((c) => c[0].query)).toEqual(["s", "so"]);
  });

  it("clears with the × button and with Escape", async () => {
    const user = userEvent.setup();
    render(<Harness onChange={() => {}} />);
    const box = screen.getByLabelText("Filter cards");
    expect(screen.queryByRole("button", { name: "Clear filter" })).toBeNull();
    await user.type(box, "ab");
    await user.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(box).toHaveValue("");
    await user.type(box, "cd{Escape}");
    expect(box).toHaveValue("");
  });

  it("has no search input in its options menu", async () => {
    const user = userEvent.setup();
    render(<Harness onChange={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Board options" }));
    expect(screen.getByText("Sort by")).toBeInTheDocument();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });
});
