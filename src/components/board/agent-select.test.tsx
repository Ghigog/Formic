import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentSelect } from "./agent-select";
import type { AgentPreset } from "@/lib/domain/entities";

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
        slot="todo"
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
        slot="in_review"
        presets={[scoped]}
        selected={undefined}
        onAssign={vi.fn()}
        onEdit={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Agent for In Review/ }));
    expect(screen.getByText("QA Reviewer")).toBeInTheDocument();
  });

  it("keeps a PM agent (no column) out of the column pickers, unless it is the one picked", async () => {
    const pm = preset({ id: "bob-1", name: "Bob", column: null });
    const user = userEvent.setup();
    const { rerender } = render(
      <AgentSelect slot="todo" presets={[pm]} selected={undefined} onAssign={vi.fn()} onEdit={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /Agent for/ }));
    expect(screen.queryByText("Bob")).not.toBeInTheDocument();

    rerender(<AgentSelect slot="todo" presets={[pm]} selected={pm} onAssign={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByRole("menuitemradio", { name: /Bob/ })).toBeInTheDocument();
  });

  it("links to Settings to add a key when no agent has one", async () => {
    const user = userEvent.setup();
    render(
      <AgentSelect slot="todo" presets={[preset({ hasKey: false })]} selected={undefined} onAssign={vi.fn()} onEdit={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /Agent for To Do/ }));
    expect(screen.getByRole("link", { name: /Add a key in Settings/ })).toHaveAttribute("href", "/settings");
  });

  it("shows the picked agent and no Settings link when a key exists", async () => {
    const user = userEvent.setup();
    const bob = preset({ id: "bob-1", name: "Bob", column: "todo" });
    const onAssign = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <AgentSelect slot="todo" presets={[bob]} selected={undefined} onAssign={onAssign} onEdit={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /Agent for To Do/ }));
    expect(screen.queryByRole("link", { name: /Settings/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitemradio", { name: /Bob/ }));
    expect(onAssign).toHaveBeenCalledWith("bob-1");
    rerender(<AgentSelect slot="todo" presets={[bob]} selected={bob} onAssign={onAssign} onEdit={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Agent for To Do: Bob/ })).toHaveTextContent("Bob");
  });

  it("the PM's slot lists only PM agents plus the selected one, labelled for the PM", async () => {
    const pm = preset({ id: "pm-1", name: "Planner", column: null });
    const col = preset({ id: "c-1", name: "Builder", column: "in_progress" });
    const user = userEvent.setup();
    render(
      <AgentSelect slot="assistant" presets={[pm, col]} selected={pm} onAssign={vi.fn()} onEdit={vi.fn()} />,
    );
    const trigger = screen.getByRole("button", { name: /The PM's agent: Planner/ });
    expect(trigger.closest("[data-tour]")).toBeNull();
    await user.click(trigger);
    expect(screen.getByRole("menu", { name: "Agents for the PM" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /Planner/ })).toBeInTheDocument();
    expect(screen.queryByText("Builder")).not.toBeInTheDocument();
  });

  it("the PM's slot reads PM Agent when none is chosen", () => {
    render(<AgentSelect slot="assistant" presets={[]} selected={undefined} onAssign={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByText("PM Agent")).toBeInTheDocument();
  });

  describe("out of usage", () => {
    const limited = () =>
      preset({
        name: "Claude (work)",
        limitedUntil: new Date(Date.now() + 2 * 3_600_000 + 5 * 60_000).toISOString(),
        limitNote: "Hit its usage limit.",
      });

    it("shows the warning and countdown, and still opens the menu to switch agents", async () => {
      const mine = { ...limited(), column: "todo" as const };
      const other = preset({ id: "p2", name: "Other", column: "todo" });
      const onAssign = vi.fn().mockResolvedValue(undefined);
      const user = userEvent.setup();
      render(
        <AgentSelect slot="todo" presets={[mine, other]} selected={mine} onAssign={onAssign} onEdit={vi.fn()} />,
      );
      const trigger = screen.getByRole("button", { name: /Agent for To Do: Claude \(work\), out of usage until .*\. Change/ });
      expect(trigger).toHaveAttribute("title", "Hit its usage limit.");
      expect(screen.getByRole("status")).toHaveTextContent("Claude (work) is out of usage · back at");
      expect(screen.getByLabelText(/^Available in 2:0[45]:\d\d$/)).toBeInTheDocument();
      await user.click(trigger);
      await user.click(screen.getByRole("menuitemradio", { name: /Other/ }));
      expect(onAssign).toHaveBeenCalledWith("p2");
    });
  });
});
