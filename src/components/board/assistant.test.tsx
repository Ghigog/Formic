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
    const shade = container.querySelector("section[aria-label=PM]")!;
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
    const box = screen.getByLabelText("Ask the PM");
    await userEvent.setup().type(box, "hello{Enter}");
    expect(ask).toHaveBeenCalledWith("hello");
    expect(box).toHaveValue("");
  });

  it("adds a line on Shift+Enter without sending", async () => {
    const ask = vi.fn();
    render(<AskBox a={{ ...controls, ask }} repoName="demo" />);
    const box = screen.getByLabelText("Ask the PM");
    await userEvent.setup().type(box, "one{Shift>}{Enter}{/Shift}two");
    expect(ask).not.toHaveBeenCalled();
    expect(box).toHaveValue("one\ntwo");
  });

  it("still sends on Cmd+Enter and Ctrl+Enter", async () => {
    const ask = vi.fn();
    render(<AskBox a={{ ...controls, ask }} repoName="demo" />);
    const box = screen.getByLabelText("Ask the PM");
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
    await user.type(screen.getByLabelText("Ask the PM"), "{Enter}");
    expect(ask).not.toHaveBeenCalled();
    rerender(
      <AskBox a={{ ...controls, ask, pending: true }} repoName="demo" />,
    );
    await user.type(screen.getByLabelText("Ask the PM"), "hi{Enter}");
    expect(ask).not.toHaveBeenCalled();
  });

  it("swaps Send for Stop while pending, and stops on click", async () => {
    const stop = vi.fn();
    render(<AskBox a={{ ...controls, pending: true, stop }} repoName="demo" />);
    expect(screen.queryByLabelText("Send")).toBeNull();
    const box = screen.getByLabelText("Ask the PM");
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
      "section[aria-label=PM]",
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

  it("shows how many questions the PM has for the person, and none when there are none", () => {
    const { rerender } = render(<AskButton a={{ ...controls, questions: 2 }} repoName="demo" />);
    expect(screen.getByTestId("pm-questions")).toHaveTextContent("2");
    expect(screen.getByLabelText("2 questions for you")).toBeInTheDocument();
    rerender(<AskButton a={{ ...controls, questions: 0 }} repoName="demo" />);
    expect(screen.queryByTestId("pm-questions")).toBeNull();
  });
});

describe("AskBox's prompt", () => {
  it("says the PM has a question waiting", () => {
    render(<AskBox a={{ ...controls, open: false, questions: 1 }} repoName="demo" />);
    expect(screen.getByLabelText("Ask the PM")).toHaveAttribute("placeholder", "The PM has a question for you…");
  });
});

describe("proposal cards", () => {
  Element.prototype.scrollTo = vi.fn();

  const withProposal = (
    state: "proposed" | "applied" | "dismissed" | "failed",
    error?: string,
  ): AssistantControls => ({
    ...controls,
    messages: [
      {
        id: "m1",
        role: "assistant",
        content: "Here is a plan",
        status: "done",
        proposals: [
          {
            summary: "Add dark mode",
            action: { type: "create_backlog_item", request: "Do it" },
            state,
            error,
          },
        ],
      },
    ],
  });
  const card = () =>
    screen.getByText("Add dark mode").closest<HTMLElement>("[data-state]")!;

  const body = () => screen.getByText("Add dark mode").parentElement!;

  it("shows a proposed card at full strength with enabled buttons", () => {
    render(<AskBox a={withProposal("proposed")} repoName="demo" />);
    expect(card()).toHaveAttribute("data-state", "proposed");
    expect(body()).not.toHaveClass("opacity-60");
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeEnabled();
  });

  it("grays out an approved card and drops the buttons", () => {
    render(<AskBox a={withProposal("applied")} repoName="demo" />);
    expect(card()).toHaveAttribute("data-state", "applied");
    expect(body()).toHaveClass("opacity-60");
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("grays out a dismissed card", () => {
    render(<AskBox a={withProposal("dismissed")} repoName="demo" />);
    expect(card()).toHaveAttribute("data-state", "dismissed");
    expect(body()).toHaveClass("opacity-60");
    expect(screen.getByText("Dismissed")).toBeInTheDocument();
  });

  it("grays out a failed card but keeps the error", () => {
    render(<AskBox a={withProposal("failed", "boom")} repoName="demo" />);
    expect(card()).toHaveAttribute("data-state", "failed");
    expect(body()).toHaveClass("opacity-60");
    expect(screen.getByText("Could not apply: boom")).toBeInTheDocument();
  });

  it("grays out once the decision completes, without a reload", () => {
    const { rerender } = render(
      <AskBox a={withProposal("proposed")} repoName="demo" />,
    );
    rerender(<AskBox a={withProposal("applied")} repoName="demo" />);
    expect(body()).toHaveClass("opacity-60");
  });
});

describe("message formatting", () => {
  Element.prototype.scrollTo = vi.fn();

  it("formats an assistant reply but leaves the person's message literal", () => {
    const a: AssistantControls = {
      ...controls,
      messages: [
        { id: "u", role: "user", content: "say **x**", status: "done", proposals: [] },
        { id: "a", role: "assistant", content: "- **x** and `y`", status: "done", proposals: [] },
      ],
    };
    render(<AskBox a={a} repoName="demo" />);
    expect(screen.getByText("say **x**")).toBeInTheDocument();
    expect(screen.getByText("x").tagName).toBe("STRONG");
    expect(screen.getByText("y").tagName).toBe("CODE");
  });
});

describe("list scrolling", () => {
  it("scrolls to the bottom on open, and not again when messages change", () => {
    const scrollTo = vi.fn();
    Element.prototype.scrollTo = scrollTo;
    const msg = (content: string) => ({
      id: "a",
      role: "assistant" as const,
      content,
      status: "done" as const,
      proposals: [],
    });
    const { rerender } = render(
      <AskBox a={{ ...controls, messages: [msg("one")] }} repoName="demo" />,
    );
    expect(scrollTo).toHaveBeenCalledTimes(1);
    rerender(
      <AskBox a={{ ...controls, messages: [msg("one two")] }} repoName="demo" />,
    );
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });
});
