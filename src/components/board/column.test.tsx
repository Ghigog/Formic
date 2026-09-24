import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Column, columnCount } from "./column";
import { renderInDnd } from "@/test/render";
import { makeCard, makeEpicWithChildren } from "@/test/cards";

const noop = vi.fn();

function column(id: Parameters<typeof Column>[0]["id"], cards = [makeCard()]) {
  return renderInDnd(
    <Column id={id} cards={cards} extras={{}} onOpen={noop} />,
  );
}

describe("columnCount", () => {
  /*
   * The count is work items, not render nodes. An epic that has absorbed its
   * tickets into an accordion counts as those tickets — the accordion is one
   * card on screen but four things to do — while an epic whose tickets are
   * elsewhere counts as itself.
   */
  it("counts an epic's absorbed tickets, not the accordion", () => {
    const cards = makeEpicWithChildren({}, [{}, {}, {}, {}]);
    expect(columnCount(cards, "todo")).toBe(4);
  });

  it("counts a childless epic as one item", () => {
    const epic = makeCard({ kind: "epic", size: null });
    const idea = makeCard();
    expect(columnCount([epic, idea], "backlog")).toBe(2);
  });

  it("does not group where the design shows cards standing alone", () => {
    const cards = makeEpicWithChildren({}, [{}, {}]);
    expect(columnCount(cards, "in_progress")).toBe(3);
  });
});

describe("Column", () => {
  it("names itself for assistive technology", () => {
    column("in_review");
    expect(screen.getByRole("region", { name: "In Review" })).toBeInTheDocument();
  });

  it("gives every rendered card its own drag handle", () => {
    const { container } = column("backlog", [makeCard(), makeCard(), makeCard()]);
    expect(container.querySelectorAll("[data-rfd-draggable-id]")).toHaveLength(3);
  });

  it("zero-pads the header count", () => {
    column("backlog", [makeCard(), makeCard()]);
    expect(screen.getByTitle("2 cards")).toHaveTextContent("02");
  });

  it("says so plainly when there is nothing here", () => {
    column("done", []);
    expect(screen.getByText("Nothing here.")).toBeInTheDocument();
  });

  it("breathes on In Progress, and nowhere else", () => {
    const { container, unmount } = column("in_progress");
    expect(container.querySelector("header .pulse-dot, .pulse-dot")).not.toBeNull();
    unmount();

    const quiet = column("todo");
    expect(quiet.container.querySelector(".pulse-dot")).toBeNull();
  });

  it("folds an epic's tickets into its accordion in To Do", () => {
    const [epic, ...kids] = makeEpicWithChildren({ title: "Agentic loop" }, [
      { title: "E2B sandbox service" },
      { title: "Coder Agent loop" },
    ]);
    const { container } = column("todo", [epic!, ...kids]);

    const groups = container.querySelectorAll("ul > li");
    expect(groups).toHaveLength(1);

    const group = within(groups[0] as HTMLElement);
    expect(group.getByText("Agentic loop")).toBeInTheDocument();
    expect(group.getByText("E2B sandbox service")).toBeInTheDocument();
    expect(group.getByText("Coder Agent loop")).toBeInTheDocument();
  });

  it("leaves tickets standing alone where the column does not group", () => {
    const [epic, ...kids] = makeEpicWithChildren({}, [{}, {}]);
    const { container } = column("in_progress", [epic!, ...kids]);
    expect(container.querySelectorAll("ul > li")).toHaveLength(3);
  });

  /*
   * Collapsing has to renumber the drag indices, which must run 0..n-1 over
   * exactly what is rendered or @hello-pangea/dnd drops cards in the wrong
   * place. Asserting on the rendered indices is the cheapest way to catch a
   * regression that would otherwise only show up mid-drag.
   */
  it("hands out contiguous drag indices across an expanded accordion", () => {
    const [epic, ...kids] = makeEpicWithChildren({}, [{}, {}, {}]);
    const { container } = column("todo", [epic!, ...kids]);

    const ids = [...container.querySelectorAll("[data-rfd-draggable-id]")];
    expect(ids).toHaveLength(4);
  });

  it("renumbers when an accordion collapses", async () => {
    const user = userEvent.setup();
    const [epic, ...kids] = makeEpicWithChildren({}, [{}, {}, {}]);
    const { container } = column("todo", [epic!, ...kids]);

    await user.click(screen.getByRole("button", { name: "Collapse child tickets" }));

    expect(container.querySelectorAll("[data-rfd-draggable-id]")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Expand child tickets" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("renders the composer it is given, above the cards", () => {
    renderInDnd(
      <Column
        id="backlog"
        cards={[makeCard()]}
        extras={{}}
        composer={<p>composer</p>}
        onOpen={noop}
      />,
    );
    expect(screen.getByText("composer")).toBeInTheDocument();
  });

  it("drops the well and its header on mobile, where the tab bar carries them", () => {
    const { container } = renderInDnd(
      <Column id="todo" cards={[makeCard()]} extras={{}} bare onOpen={noop} />,
    );
    expect(screen.queryByRole("heading", { name: "To Do" })).toBeNull();
    expect(container.firstElementChild!.className).not.toContain("bg-column");
  });
});

describe("Column with an agent out of usage", () => {
  const preset = {
    id: "p1",
    ownerId: null,
    name: "Claude (work)",
    provider: "claude-code" as const,
    model: "",
    prompt: "",
    hasKey: true,
    keyHint: "1234",
    limitedUntil: new Date(Date.now() + 2 * 3_600_000 + 5 * 60_000).toISOString(),
    limitNote: "Claude Code hit its usage limit.",
  };

  it("counts down to when it is back, at the front of the column", () => {
    renderInDnd(
      <Column
        id="in_progress"
        cards={[]}
        extras={{}}
        onOpen={noop}
        agent={{ presets: [preset], selected: preset, onAssign: vi.fn(), onEdit: vi.fn(), onClearLimit: vi.fn() }}
      />,
    );
    const region = screen.getByRole("region", { name: "In Progress" });
    expect(region).toHaveAttribute("data-limited", "true");
    expect(within(region).getByRole("status")).toHaveTextContent("Claude (work) is out of usage");
    expect(within(region).getByLabelText(/^Available in 2:0[45]:\d\d$/)).toBeInTheDocument();
  });

  it("clears a stale or wrongly attributed limit by hand", async () => {
    const onClearLimit = vi.fn();
    renderInDnd(
      <Column
        id="in_progress"
        cards={[]}
        extras={{}}
        onOpen={noop}
        agent={{ presets: [preset], selected: preset, onAssign: vi.fn(), onEdit: vi.fn(), onClearLimit }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /wrong\? clear/i }));
    expect(onClearLimit).toHaveBeenCalledWith("p1");
  });

  it("is open again once the time has passed", () => {
    const back = { ...preset, limitedUntil: new Date(Date.now() - 1000).toISOString() };
    renderInDnd(
      <Column
        id="in_progress"
        cards={[]}
        extras={{}}
        onOpen={noop}
        agent={{ presets: [back], selected: back, onAssign: vi.fn(), onEdit: vi.fn(), onClearLimit: vi.fn() }}
      />,
    );
    expect(screen.getByRole("region", { name: "In Progress" })).not.toHaveAttribute("data-limited");
  });
});
