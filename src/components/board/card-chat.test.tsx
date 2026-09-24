import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { CardChat } from "./card-chat";

vi.mock("@/lib/hooks/use-card-chat", () => ({
  useCardChat: () => ({
    messages: [
      { id: "1", role: "user", content: "How's it going?", status: "done" },
      { id: "2", role: "assistant", content: "Halfway there.", status: "done" },
    ],
    pending: false,
    error: null,
    ask: vi.fn(),
    clear: vi.fn(),
  }),
}));

describe("CardChat", () => {
  it("shows the conversation with its input", () => {
    render(<CardChat kind="epic" cardId="e1" agentLabel="Architect" />);
    expect(screen.getByText("Halfway there.")).toBeInTheDocument();
    expect(screen.getByLabelText("Ask the Architect Agent")).toBeInTheDocument();
  });

  it("is only the input when the conversation shows elsewhere, as on a ticket", () => {
    render(<CardChat kind="ticket" cardId="t1" agentLabel="Coder" inputOnly />);
    expect(screen.getByLabelText("Ask the Coder Agent")).toBeInTheDocument();
    expect(screen.queryByText("Halfway there.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear chat" })).not.toBeInTheDocument();
  });
});
