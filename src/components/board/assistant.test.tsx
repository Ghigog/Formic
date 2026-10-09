import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AskBox, type AssistantControls } from "./assistant";

const controls: AssistantControls = {
  open: true,
  setOpen: vi.fn(),
  presetId: null,
  messages: [],
  pending: false,
  error: null,
  ask: vi.fn(),
  stop: vi.fn(),
  clear: vi.fn(),
  decide: vi.fn(),
  setAgent: vi.fn(),
  presets: [],
  onNewAgent: vi.fn(),
  onEditAgent: vi.fn(),
};

describe("AskBox", () => {
  Element.prototype.scrollTo = vi.fn();

  it("anchors the shade to the viewport, not the composer", () => {
    const { container } = render(<AskBox a={controls} repoName="demo" />);
    const shade = container.querySelector("section[aria-label=Assistant]")!;
    expect(shade).toHaveClass(
      "fixed",
      "top-16",
      "left-1/2",
      "-translate-x-1/2",
    );
    expect(shade).not.toHaveClass("absolute");
  });

  it("sends on Cmd+Enter and Ctrl+Enter, not on Enter or Shift+Enter", async () => {
    const ask = vi.fn();
    render(<AskBox a={{ ...controls, ask }} repoName="demo" />);
    const box = screen.getByLabelText("Ask the assistant");
    const user = userEvent.setup();
    await user.type(box, "one{Shift>}{Enter}{/Shift}two{Enter}");
    expect(ask).not.toHaveBeenCalled();
    expect(box).toHaveValue("one\ntwo\n");
    await user.type(box, "{Control>}{Enter}{/Control}");
    expect(ask).toHaveBeenCalledWith("one\ntwo");
    await user.type(box, "x{Meta>}{Enter}{/Meta}");
    expect(ask).toHaveBeenLastCalledWith("x");
  });

  it("swaps Send for Stop while pending, and stops on click", async () => {
    const stop = vi.fn();
    render(<AskBox a={{ ...controls, pending: true, stop }} repoName="demo" />);
    expect(screen.queryByLabelText("Send")).toBeNull();
    const box = screen.getByLabelText("Ask the assistant");
    expect(box).not.toBeDisabled();
    await userEvent.setup().click(screen.getByLabelText("Stop"));
    expect(stop).toHaveBeenCalled();
    expect(box).toHaveFocus();
  });
});
