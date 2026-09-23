import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewItemDialog } from "./new-item-dialog";

describe("NewItemDialog", () => {
  it("says a request reads as a bug before it is filed", async () => {
    render(<NewItemDialog open onClose={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByText("Product Agent")).toBeInTheDocument();

    await userEvent.setup().type(screen.getByLabelText("New feature request"), "Fix the broken badge");
    expect(screen.getByText("Tagged as bug · −5 points")).toBeInTheDocument();
  });

  it("drafts on submit and closes", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<NewItemDialog open onClose={onClose} onSubmit={onSubmit} />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("New feature request"), "Rate-limit the merge queue");
    await user.click(screen.getByRole("button", { name: "Draft PRD" }));

    expect(onSubmit).toHaveBeenCalledWith("Rate-limit the merge queue");
    expect(onClose).toHaveBeenCalled();
  });
});
