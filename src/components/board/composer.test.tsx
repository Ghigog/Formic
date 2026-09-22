import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BacklogComposer } from "./composer";

describe("BacklogComposer", () => {
  it("labels its input, which is a real input and not a modal", () => {
    render(<BacklogComposer onSubmit={vi.fn()} />);
    expect(screen.getByLabelText("New feature request")).toHaveProperty(
      "tagName",
      "INPUT",
    );
  });

  it("passes the trimmed request to the Product Agent", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<BacklogComposer onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("New feature request"), "  Merge queue  ");
    await user.click(screen.getByRole("button", { name: "Draft PRD" }));

    expect(onSubmit).toHaveBeenCalledWith("Merge queue");
  });

  it("clears once the request is captured, ready for the next one", async () => {
    const user = userEvent.setup();
    render(<BacklogComposer onSubmit={vi.fn().mockResolvedValue(undefined)} />);

    const input = screen.getByLabelText<HTMLInputElement>("New feature request");
    await user.type(input, "Merge queue");
    await user.click(screen.getByRole("button", { name: "Draft PRD" }));

    expect(input.value).toBe("");
  });

  it("refuses a request too short to expand into a PRD", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<BacklogComposer onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("New feature request"), "hi");
    await user.click(screen.getByRole("button", { name: "Draft PRD" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Describe the feature in a sentence.",
    );
  });

  it("keeps the text and shows why when the server rejects it", async () => {
    const user = userEvent.setup();
    render(
      <BacklogComposer
        onSubmit={vi.fn().mockRejectedValue(new Error("Budget exhausted."))}
      />,
    );

    const input = screen.getByLabelText<HTMLInputElement>("New feature request");
    await user.type(input, "Concurrent merge queue");
    await user.click(screen.getByRole("button", { name: "Draft PRD" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Budget exhausted.");
    expect(input.value).toBe("Concurrent merge queue");
  });
});
