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

  it("sends on Enter and clears the field", async () => {
    const ask = vi.fn();
    render(<AskBox a={{ ...controls, ask }} repoName="demo" />);
    const box = screen.getByLabelText("Ask the assistant");
    await userEvent.setup().type(box, "hello{Enter}");
    expect(ask).toHaveBeenCalledWith("hello");
    expect(box).toHaveValue("");
  });

  it("adds a line on Shift+Enter without sending", async () => {
    const ask = vi.fn();
    render(<AskBox a={{ ...controls, ask }} repoName="demo" />);
    const box = screen.getByLabelText("Ask the assistant");
    await userEvent.setup().type(box, "one{Shift>}{Enter}{/Shift}two");
    expect(ask).not.toHaveBeenCalled();
    expect(box).toHaveValue("one\ntwo");
  });

  it("still sends on Cmd+Enter and Ctrl+Enter", async () => {
    const ask = vi.fn();
    render(<AskBox a={{ ...controls, ask }} repoName="demo" />);
    const box = screen.getByLabelText("Ask the assistant");
    const user = userEvent.setup();
    await user.type(box, "a{Control>}{Enter}{/Control}");
    expect(ask).toHaveBeenLastCalledWith("a");
    await user.type(box, "b{Meta>}{Enter}{/Meta}");
    expect(ask).toHaveBeenLastCalledWith("b");
  });

  it("does not send on Enter when empty or while an answer is pending", async () => {
    const ask = vi.fn();
    const { rerender } = render(
      <AskBox a={{ ...controls, ask }} repoName="demo" />,
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Ask the assistant"), "{Enter}");
    expect(ask).not.toHaveBeenCalled();
    rerender(
      <AskBox a={{ ...controls, ask, pending: true }} repoName="demo" />,
    );
    await user.type(screen.getByLabelText("Ask the assistant"), "hi{Enter}");
    expect(ask).not.toHaveBeenCalled();
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
