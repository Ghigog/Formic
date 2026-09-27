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
});
