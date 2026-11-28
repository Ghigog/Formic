import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CardTokens } from "./card-tokens";

const stay = (column: string, tokensIn: number, tokensOut: number, unreported = false) => ({
  column,
  enteredAt: "2026-01-01T00:00:00Z",
  exitedAt: null,
  tokensIn,
  tokensOut,
  unreported,
});

function respond(body: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => body }));
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(cleanup);

describe("CardTokens", () => {
  it("lists a row per stay in order and the total", async () => {
    respond({
      stays: [stay("in_progress", 100_000, 20_000), stay("in_review", 4_000, 1_000), stay("in_progress", 25_000, 5_000), stay("in_review", 3_000, 1_000)],
      totalIn: 132_000,
      totalOut: 27_000,
      unreported: false,
    });
    render(<CardTokens cardId="t1" kind="ticket" />);
    await screen.findByText("Tokens");
    const rows = screen.getAllByRole("listitem").map((r) => r.textContent);
    expect(rows).toEqual(["In Progress120.0k", "In Review5.0k", "In Progress30.0k", "In Review4.0k"]);
    expect(screen.getByText("Total").parentElement?.textContent).toBe("Total159.0k");
    expect(fetch).toHaveBeenCalledWith("/api/cards/t1/tokens?kind=ticket", { cache: "no-store" });
  });

  it("shows the in/out split on focus", async () => {
    respond({ stays: [stay("in_progress", 100_000, 20_000)], totalIn: 100_000, totalOut: 20_000, unreported: false });
    render(<CardTokens cardId="t1" kind="epic" />);
    const count = (await screen.findAllByRole("button"))[0]!;
    expect(count.getAttribute("title")).toBe("100.0k in · 20.0k out");
    fireEvent.focus(count);
    expect(screen.getByRole("tooltip").textContent).toBe("100.0k in · 20.0k out");
  });

  it("notes unreported work and shows – rather than 0 tokens", async () => {
    respond({ stays: [stay("in_progress", 0, 0, true)], totalIn: 0, totalOut: 0, unreported: true });
    render(<CardTokens cardId="t1" kind="ticket" />);
    await waitFor(() => screen.getByText(/doesn.t report tokens/));
    expect(screen.getByText("Total").parentElement?.textContent).toBe("Total–");
    expect(document.body.textContent).not.toMatch(/0 tokens/);
  });
});
