import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CardChat } from "./card-chat";
import { useCardChat } from "@/lib/hooks/use-card-chat";

const base = () => ({
    messages: [
      { id: "1", role: "user", content: "How's it going? **stars**", status: "done" },
      {
        id: "2",
        role: "assistant",
        content: "Halfway **there**.",
        status: "done",
        tokensIn: 141_200,
        tokensOut: 41_200,
        costCents: 12.4,
      },
    ],
    pending: false,
    error: null,
    ask: vi.fn(),
    clear: vi.fn(),
    hasEarlier: false,
    loadingEarlier: false,
    earlierError: null,
    loadEarlier: vi.fn(),
});

vi.mock("@/lib/hooks/use-card-chat", () => ({ useCardChat: vi.fn() }));
beforeEach(() => vi.mocked(useCardChat).mockImplementation(() => base() as never));

describe("CardChat", () => {
  it("shows the conversation with its input", () => {
    render(<CardChat kind="epic" cardId="e1" agentLabel="Architect" />);
    expect(screen.getByText(/Halfway/)).toBeInTheDocument();
    expect(screen.getByLabelText("Message the Architect Agent")).toBeInTheDocument();
  });

  it("says what an answer used, in tokens, and says nothing under the person's own message", () => {
    render(<CardChat kind="epic" cardId="e1" agentLabel="Architect" />);
    // Tokens only: the cents on the row are an estimate from a hand-kept
    // price table, so they are not shown as if they were a bill.
    expect(screen.getByText("182.4k tokens")).toBeInTheDocument();
    expect(screen.queryByText(/¢/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/tokens/)).toHaveLength(1);
  });

  it("is only the input when the conversation shows elsewhere, as on a ticket", () => {
    render(<CardChat kind="ticket" cardId="t1" agentLabel="Coder" inputOnly />);
    expect(screen.getByLabelText("Message the Coder Agent")).toBeInTheDocument();
    expect(screen.queryByText(/Halfway/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear chat" })).not.toBeInTheDocument();
  });

  it("formats an agent reply but shows the person's own message as typed", () => {
    render(<CardChat kind="epic" cardId="e1" agentLabel="Architect" />);
    expect(screen.getByText("there").tagName).toBe("STRONG");
    expect(screen.getByText("How's it going? **stars**")).toBeInTheDocument();
  });
});

describe("Earlier messages", () => {
  const mk = (over: Record<string, unknown> = {}) => {
    vi.mocked(useCardChat).mockReturnValue({
      ...base(),
      hasEarlier: true,
      loadEarlier: vi.fn().mockResolvedValue(undefined),
      ...over,
    } as never);
  };

  it("shows the link only when there is something earlier, and asks for it when tapped", async () => {
    const loadEarlier = vi.fn().mockResolvedValue(undefined);
    mk({ loadEarlier });
    const { rerender } = render(<CardChat kind="ticket" cardId="t1" agentLabel="Architect" />);
    await userEvent.click(screen.getByRole("button", { name: "Earlier messages" }));
    expect(loadEarlier).toHaveBeenCalled();
    mk({ hasEarlier: false });
    rerender(<CardChat kind="ticket" cardId="t1" agentLabel="Architect" />);
    expect(screen.queryByText("Earlier messages")).toBeNull();
  });

  it("reads Loading… as plain text while it loads", () => {
    mk({ loadingEarlier: true });
    render(<CardChat kind="ticket" cardId="t1" agentLabel="Architect" />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Earlier messages" })).toBeNull();
  });

  it("shows a failure inline", () => {
    mk({ earlierError: "Nope." });
    render(<CardChat kind="ticket" cardId="t1" agentLabel="Architect" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Nope.");
  });
});
