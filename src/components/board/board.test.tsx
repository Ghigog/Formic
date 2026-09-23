import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Board, type BoardProps } from "./board";
import { makeCard, makeEpicWithChildren } from "@/test/cards";
import { setViewportMatches } from "@/test/viewport";
import type { BoardCard } from "@/lib/domain/entities";
import type { TransitionResult } from "@/lib/domain/transitions";

/**
 * Integration level: the board wired to its columns and cards, with the
 * server replaced by a spy. What it is for is the trigger contract — a user
 * move must produce exactly one typed transition, and a refusal must put the
 * card back — because every later ticket hangs off that one event.
 *
 * The drag gesture itself is not here. jsdom reports every box as 0×0, so
 * @hello-pangea/dnd cannot decide where a card landed. Dragging is covered in
 * e2e/board.spec.ts against a real browser and a real server.
 */
function renderBoard(
  cards: BoardCard[],
  overrides: Partial<BoardProps> = {},
): { onTransition: ReturnType<typeof vi.fn> } {
  const onTransition = vi.fn(
    async (): Promise<TransitionResult> => ({ ok: true, status: "ready", runId: null }),
  );

  render(
    <Board
      cards={cards}
      projectName="Formic"
      repoFullName="formic-labs/formic-web"
      baseBranch="main"
      onOpenCard={vi.fn()}
      onNewItem={vi.fn()}
      onTransition={onTransition}
      {...overrides}
    />,
  );

  return { onTransition };
}

describe("Board, on a wide screen", () => {
  it("renders all five columns", () => {
    renderBoard([makeCard()]);
    for (const name of ["Backlog", "To Do", "In Progress", "In Review", "Done"]) {
      expect(screen.getByRole("region", { name })).toBeInTheDocument();
    }
  });

  it("starts new requests from the Backlog, and nowhere else on a wide screen", async () => {
    const onNewItem = vi.fn();
    renderBoard([makeCard({ status: "draft" })], { onNewItem });

    const buttons = screen.getAllByRole("button", { name: "New request" });
    expect(buttons).toHaveLength(1);
    expect(
      screen.getByRole("region", { name: "Backlog" }).contains(buttons[0]!),
    ).toBe(true);

    await userEvent.setup().click(buttons[0]!);
    expect(onNewItem).toHaveBeenCalledOnce();
  });

  it("sends a card on with its arrow: one typed transition", async () => {
    const card = makeCard({ key: "PROT-09", status: "draft" });
    const { onTransition } = renderBoard([card]);

    await userEvent.setup().click(
      screen.getByRole("button", { name: "Move PROT-09 to To Do" }),
    );

    expect(onTransition).toHaveBeenCalledOnce();
    expect(onTransition.mock.calls[0]![0]).toMatchObject({
      cardId: card.id,
      from: "backlog",
      to: "todo",
      actor: "user",
    });
  });

  it("gives no arrow to a card that could not take the step", () => {
    renderBoard([
      makeCard({ key: "PROT-10", status: "waiting" }),
      makeCard({ key: "PROT-11", status: "merged" }),
    ]);
    expect(screen.queryByRole("button", { name: /^Move PROT-10/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Move PROT-11/ })).toBeNull();
  });

  it("gives a ready ticket its arrow into In Progress", () => {
    renderBoard([makeCard({ key: "PROT-12", status: "ready" })]);
    expect(
      screen.getByRole("button", { name: "Move PROT-12 to In Progress" }),
    ).toBeInTheDocument();
  });

  /*
   * Both headers are in the DOM at once — the wide one and the app bar — and
   * CSS hides whichever does not apply. A real browser drops the hidden one
   * from the accessibility tree; jsdom loads no CSS, so it sees both. Only
   * the app bar carries the CTA now: on a wide screen, Backlog has its own.
   */
  it("routes the app bar's CTA to the capture dialog", async () => {
    const onNewItem = vi.fn();
    renderBoard([makeCard()], { onNewItem });

    const ctas = screen.getAllByRole("button", { name: "New backlog item" });
    expect(ctas).toHaveLength(1);

    await userEvent.setup().click(ctas[0]!);
    expect(onNewItem).toHaveBeenCalledOnce();
  });
});

describe("Board, below 768px", () => {
  it("shows one column at a time, with the tab bar carrying the counts", async () => {
    setViewportMatches(true);
    const [epic, ...kids] = makeEpicWithChildren({ status: "ready" }, [
      { status: "ready" },
      { status: "waiting" },
    ]);
    renderBoard([makeCard({ status: "draft" }), epic!, ...kids]);

    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Backlog/ })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "To Do 2" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "To Do" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "To Do 2" }));
    expect(screen.getByRole("region", { name: "To Do" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Backlog" })).toBeNull();
  });

  /*
   * The artboard's floating button does not say which card it moves. Naming
   * the card in the accessible name is the one addition: an action that moves
   * "something" is not an action anybody can trust.
   */
  it("names the card the floating action will move", async () => {
    setViewportMatches(true);
    renderBoard([makeCard({ key: "PROT-09", status: "draft" })]);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Advance PROT-09 to To Do" }),
      ).toBeInTheDocument(),
    );
  });

  it("offers no advance where nothing in the column can move", async () => {
    setViewportMatches(true);
    renderBoard([makeCard({ status: "merged" })]);

    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Done 1" })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Done 1" }));

    expect(screen.queryByRole("button", { name: /^Advance/ })).toBeNull();
  });

  it("emits one typed transition when a card advances", async () => {
    setViewportMatches(true);
    const card = makeCard({ key: "PROT-09", status: "draft" });
    const { onTransition } = renderBoard([card]);

    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Advance/ })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /^Advance/ }));

    expect(onTransition).toHaveBeenCalledOnce();
    expect(onTransition.mock.calls[0]![0]).toMatchObject({
      cardId: card.id,
      kind: "ticket",
      from: "backlog",
      to: "todo",
      actor: "user",
    });
  });

  it("puts the card back and says why when the server refuses", async () => {
    setViewportMatches(true);
    const onTransition = vi.fn(
      async (): Promise<TransitionResult> => ({
        ok: false,
        reason: "That epic has no PRD yet.",
        revertTo: "backlog",
      }),
    );
    renderBoard([makeCard({ key: "PROT-09", status: "draft" })], { onTransition });

    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Advance/ })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /^Advance/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That epic has no PRD yet.",
    );
    // Still in Backlog: the optimistic move was dropped, not kept.
    expect(screen.getByRole("button", { name: "Backlog 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "To Do 0" })).toBeInTheDocument();
  });
});
