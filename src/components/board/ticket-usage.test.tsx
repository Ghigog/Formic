import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TicketUsage } from "./ticket-usage";

describe("TicketUsage", () => {
  it("shows minutes used against the budget", () => {
    render(<TicketUsage usage={{ usedMinutes: 12, budgetMinutes: 20 }} />);
    expect(screen.getByText("12 of 20 minutes used")).toBeInTheDocument();
  });

  it("shows usage without a budget when none applies", () => {
    render(<TicketUsage usage={{ usedMinutes: 12, budgetMinutes: null }} />);
    expect(screen.getByText("12 minutes used")).toBeInTheDocument();
  });
});
