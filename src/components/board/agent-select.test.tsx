import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentSelect } from "./agent-select";
import type { AgentPreset } from "@/lib/domain/entities";
import type { ColumnId } from "@/lib/domain/status";

function preset(over: Partial<AgentPreset> = {}): AgentPreset {
  return {
    id: "preset-1",
    ownerId: null,
    column: null,
    name: "Agent",
    provider: "anthropic",
    model: "claude-opus-5",
    prompt: "",
    hasKey: true,
    keyHint: null,
    limitedUntil: null,
    limitNote: null,
    ...over,
  };
}

describe("AgentSelect", () => {
  it("only offers a preset scoped to another column in that column's own picker", async () => {
    const scoped = preset({ id: "reviewer-1", name: "QA Reviewer", column: "in_review" });
    const user = userEvent.setup();

    const { unmount } = render(
      <AgentSelect
        column="todo"
        presets={[scoped]}
        selected={undefined}
        onAssign={vi.fn()}
        onEdit={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Agent for To Do/ }));
    expect(screen.queryByText("QA Reviewer")).not.toBeInTheDocument();
    unmount();

    render(
      <AgentSelect
        column="in_review"
        presets={[scoped]}
        selected={undefined}
        onAssign={vi.fn()}
        onEdit={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Agent for In Review/ }));
    expect(screen.getByText("QA Reviewer")).toBeInTheDocument();
  });

  it("shows an unscoped preset in every column's picker", async () => {
    const unscoped = preset({ id: "bob-1", name: "Bob", column: null });
    const user = userEvent.setup();

    const columns: ColumnId[] = ["todo", "in_progress"];
    for (const column of columns) {
      const { unmount } = render(
        <AgentSelect
          column={column}
          presets={[unscoped]}
          selected={undefined}
          onAssign={vi.fn()}
          onEdit={vi.fn()}
        />,
      );
      await user.click(screen.getByRole("button", { name: /Agent for/ }));
      expect(screen.getByText("Bob")).toBeInTheDocument();
      unmount();
    }
  });

  it("links to Settings to add a key when no agent has one", async () => {
    const user = userEvent.setup();
    render(
      <AgentSelect column="todo" presets={[preset({ hasKey: false })]} selected={undefined} onAssign={vi.fn()} onEdit={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /Agent for To Do/ }));
    expect(screen.getByRole("link", { name: /Add a key in Settings/ })).toHaveAttribute("href", "/settings");
  });

  it("shows the picked agent and no Settings link when a key exists", async () => {
    const user = userEvent.setup();
    const bob = preset({ id: "bob-1", name: "Bob" });
    const onAssign = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <AgentSelect column="todo" presets={[bob]} selected={undefined} onAssign={onAssign} onEdit={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /Agent for To Do/ }));
    expect(screen.queryByRole("link", { name: /Settings/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitemradio", { name: /Bob/ }));
    expect(onAssign).toHaveBeenCalledWith("bob-1");
    rerender(<AgentSelect column="todo" presets={[bob]} selected={bob} onAssign={onAssign} onEdit={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Agent for To Do: Bob/ })).toHaveTextContent("Bob");
  });
});
