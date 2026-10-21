import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AskBox, AskButton, type AssistantControls } from "./assistant";

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

describe("AskButton on a phone", () => {
  Element.prototype.scrollTo = vi.fn();
  afterEach(() => vi.unstubAllGlobals());

  it("caps the shade above the keyboard and restores it when it closes", () => {
    const vv = Object.assign(new EventTarget(), { height: 800, offsetTop: 0 });
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("visualViewport", vv);
    const { container } = render(<AskButton a={controls} repoName="demo" />);
    const shade = container.querySelector<HTMLElement>(
      "section[aria-label=Assistant]",
    )!;
    const normal = shade.style.height;
    expect(normal).not.toContain("480px");
    act(() => {
      vv.height = 536;
      vv.dispatchEvent(new Event("resize"));
    });
    expect(shade.style.height).toContain("480px");
    act(() => {
      vv.height = 800;
      vv.dispatchEvent(new Event("resize"));
    });
    expect(shade.style.height).toBe(normal);
  });
});
