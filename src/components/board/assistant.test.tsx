import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AskBox, AskButton, type AssistantControls } from "./assistant";

const controls: AssistantControls = {
  boardId: "p1",
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
  onEdit: vi.fn(),
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

  it("does not send on Enter when empty, but keeps the input open for more while an answer is pending", async () => {
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
    expect(screen.getByLabelText("Ask the PM")).not.toBeDisabled();
    await user.type(screen.getByLabelText("Ask the PM"), "hi{Enter}");
    expect(ask).toHaveBeenCalledWith("hi");
  });

  it("shows a column agent's reply with its coin and name, and the PM's without", () => {
    const base = { role: "assistant" as const, status: "done" as const, proposals: [] };
    render(
      <AskBox
        a={{
          ...controls,
          messages: [
            { ...base, id: "m-1", content: "From the PM", speaker: "assistant" },
            { ...base, id: "m-2", content: "From the reviewer", speaker: "reviewer" },
          ],
        }}
        repoName="demo"
      />,
    );
    expect(screen.getByText("Reviewer")).toBeInTheDocument();
    expect(screen.getByText("From the reviewer").closest("div.flex")?.textContent).toContain("R");
    expect(screen.queryByText("PM", { selector: "p" })).toBeNull();
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

describe("the PM's waiting questions", () => {
  it("lists each question and opens its card to answer it", async () => {
    const onOpenQuestion = vi.fn();
    const setOpen = vi.fn();
    render(
      <AskBox
        a={{
          ...controls,
          open: true,
          setOpen,
          questions: 1,
          waiting: [{ id: "c-2", key: "T-2", title: "Write DESIGN.md", question: "How should this product look and feel?" }],
          onOpenQuestion,
        }}
        repoName="demo"
      />,
    );
    expect(screen.getByTestId("pm-waiting")).toHaveTextContent("How should this product look and feel?");
    await userEvent.setup().click(screen.getByRole("button", { name: /How should this product look/ }));
    expect(onOpenQuestion).toHaveBeenCalledWith("c-2");
    expect(setOpen).toHaveBeenCalledWith(false);
  });

  it("sits after the newest message, just above the composer", () => {
    render(
      <AskBox
        a={{
          ...controls,
          messages: [
            { id: "m1", role: "user", content: "first message", status: "done", proposals: [] },
            { id: "m2", role: "assistant", content: "newest message", status: "done", proposals: [] },
          ],
          questions: 1,
          waiting: [{ id: "c-2", key: "T-2", title: "Write DESIGN.md", question: "How should this look?" }],
        }}
        repoName="demo"
      />,
    );
    const newest = screen.getByText("newest message");
    const waiting = screen.getByTestId("pm-waiting");
    expect(newest.compareDocumentPosition(waiting) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  it("shows a To Do ticket proposal's request in the same muted clamp", () => {
    const a = withProposal("proposed");
    a.messages[0]!.proposals[0]!.action = { type: "create_todo_item", request: "Fix night pick-up" };
    render(<AskBox a={a} repoName="demo" />);
    expect(screen.getByText("Fix night pick-up")).toHaveClass("text-muted", "line-clamp-3");
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
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

describe("agent selector", () => {
  Element.prototype.scrollTo = vi.fn();
  const planner = {
    id: "p1", ownerId: null, column: null, name: "Planner", provider: "anthropic",
    model: "claude-opus-5", prompt: "", hasKey: true, keyHint: null, limitedUntil: null, limitNote: null,
  } as AssistantControls["presets"][number];

  it("uses the column selector, without Runs on, Edit or New agent buttons", () => {
    render(<AskBox a={{ ...controls, presets: [planner], presetId: "p1" }} repoName="demo" />);
    expect(screen.queryByText("Runs on")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New agent" })).toBeNull();
    expect(screen.getByRole("button", { name: /The PM's agent: Planner/ })).toBeInTheDocument();
  });

  it("picks, edits and creates through the selector", async () => {
    const setAgent = vi.fn().mockResolvedValue(undefined);
    const onEdit = vi.fn();
    const user = userEvent.setup();
    render(<AskBox a={{ ...controls, presets: [planner], setAgent, onEdit }} repoName="demo" />);
    await user.click(screen.getByRole("button", { name: /The PM's agent/ }));
    await user.click(screen.getByRole("menuitemradio", { name: /Planner/ }));
    expect(setAgent).toHaveBeenCalledWith("p1");
    await user.click(screen.getByRole("button", { name: /The PM's agent/ }));
    await user.click(screen.getByRole("button", { name: "Edit Planner" }));
    expect(onEdit).toHaveBeenCalledWith(planner);
    await user.click(screen.getByRole("button", { name: /The PM's agent/ }));
    await user.click(screen.getByRole("menuitem", { name: /New agent/ }));
    expect(onEdit).toHaveBeenCalledWith(null);
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

describe("Earlier messages", () => {
  Element.prototype.scrollTo = vi.fn();
  const thread = (over: Partial<AssistantControls> = {}): AssistantControls => ({
    ...controls,
    messages: [{ id: "m2", role: "user", content: "newest", status: "done", proposals: [] }],
    hasEarlier: true,
    loadingEarlier: false,
    earlierError: null,
    loadEarlier: vi.fn().mockResolvedValue(undefined),
    ...over,
  });

  it("asks for the earlier page when the link is tapped", async () => {
    const a = thread();
    render(<AskBox a={a} repoName="demo" />);
    await userEvent.click(screen.getByRole("button", { name: "Earlier messages" }));
    expect(a.loadEarlier).toHaveBeenCalled();
  });

  it("shows no link for a thread that fits one page", () => {
    render(<AskBox a={thread({ hasEarlier: false })} repoName="demo" />);
    expect(screen.queryByText("Earlier messages")).toBeNull();
  });

  it("reads Loading… as plain text while it loads", () => {
    render(<AskBox a={thread({ loadingEarlier: true })} repoName="demo" />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Earlier messages" })).toBeNull();
  });

  it("shows a failure inline", () => {
    render(<AskBox a={thread({ earlierError: "Nope." })} repoName="demo" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Nope.");
  });
});

describe("unread PM messages", () => {
  it("shows the count on the button, and hides it at none", () => {
    const { rerender } = render(<AskButton a={{ ...controls, unread: 3 }} repoName="demo" />);
    expect(screen.getByTestId("pm-unread")).toHaveTextContent("3");
    expect(screen.getByLabelText("3 new messages from the PM")).toBeInTheDocument();
    rerender(<AskButton a={{ ...controls, unread: 0 }} repoName="demo" />);
    expect(screen.queryByTestId("pm-unread")).toBeNull();
  });

  it("sits on the left when the question count shows too, and keeps both counts", () => {
    render(<AskButton a={{ ...controls, unread: 1, questions: 2 }} repoName="demo" />);
    expect(screen.getByTestId("pm-unread")).toHaveClass("-left-1");
    expect(screen.getByTestId("pm-unread")).toHaveTextContent("1");
    expect(screen.getByTestId("pm-questions")).toHaveClass("-right-1");
    expect(screen.getByTestId("pm-questions")).toHaveTextContent("2");
  });

  it("pops in only when the count goes from none to some", () => {
    const { rerender } = render(<AskButton a={{ ...controls, unread: 2 }} repoName="demo" />);
    expect(screen.getByTestId("pm-unread")).not.toHaveClass("pm-badge-pop");
    rerender(<AskButton a={{ ...controls, unread: 0 }} repoName="demo" />);
    rerender(<AskButton a={{ ...controls, unread: 1 }} repoName="demo" />);
    expect(screen.getByTestId("pm-unread")).toHaveClass("pm-badge-pop");
    rerender(<AskButton a={{ ...controls, unread: 2 }} repoName="demo" />);
    expect(screen.getByTestId("pm-unread")).not.toHaveClass("pm-badge-pop");
  });

  const at = (id: string, createdAt: string, extra = {}) => ({
    id,
    role: "assistant" as const,
    content: `text ${id}`,
    status: "done" as const,
    proposals: [],
    createdAt,
    ...extra,
  });

  it("puts a New rule above the first message newer than the last read", () => {
    render(
      <AskBox
        a={{
          ...controls,
          readAt: "2026-11-12T10:00:00.000Z",
          messages: [
            at("m1", "2026-11-12T09:00:00.000Z"),
            at("m2", "2026-11-12T11:00:00.000Z"),
            at("m3", "2026-11-12T12:00:00.000Z"),
          ],
        }}
        repoName="demo"
      />,
    );
    const rule = screen.getByTestId("pm-new");
    expect(screen.getAllByTestId("pm-new")).toHaveLength(1);
    expect(rule).toHaveTextContent("New");
    expect(screen.getByText("text m1").compareDocumentPosition(rule) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rule.compareDocumentPosition(screen.getByText("text m2")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows no New rule when everything was read", () => {
    render(
      <AskBox
        a={{ ...controls, readAt: "2026-11-12T10:00:00.000Z", messages: [at("m1", "2026-11-12T09:00:00.000Z")] }}
        repoName="demo"
      />,
    );
    expect(screen.queryByTestId("pm-new")).toBeNull();
  });

  it("opens a linked card from its chip and rolls the chat up", async () => {
    const onOpenQuestion = vi.fn();
    const setOpen = vi.fn();
    render(
      <AskBox
        a={{
          ...controls,
          setOpen,
          onOpenQuestion,
          messages: [at("m1", "2026-11-12T09:00:00.000Z", { cards: [{ id: "c-9", key: "T-9", title: "Add dark mode" }] })],
        }}
        repoName="demo"
      />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "T-9 · Add dark mode" }));
    expect(onOpenQuestion).toHaveBeenCalledWith("c-9");
    expect(setOpen).toHaveBeenCalledWith(false);
  });
});

describe("per-board PM drafts", () => {
  const field = () => screen.getByPlaceholderText(/Ask the PM about/) as HTMLTextAreaElement;

  it("keeps an unsent AskBox draft on its own board, including across a re-render", async () => {
    const user = userEvent.setup();
    const { rerender, unmount } = render(<AskBox a={{ ...controls, boardId: "o/a" }} repoName="a" />);
    await user.type(field(), "half a thought");
    rerender(<AskBox a={{ ...controls, boardId: "o/b" }} repoName="b" />);
    expect(field().value).toBe("");
    rerender(<AskBox a={{ ...controls, boardId: "o/a" }} repoName="a" />);
    expect(field().value).toBe("half a thought");
    unmount();
    render(<AskBox a={{ ...controls, boardId: "o/b" }} repoName="b" />);
    expect(field().value).toBe("");
  });

  it("keeps the mobile shade's draft per board", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<AskButton a={{ ...controls, boardId: "o/a" }} repoName="a" />);
    await user.type(field(), "on a phone");
    rerender(<AskButton a={{ ...controls, boardId: "o/b" }} repoName="b" />);
    expect(field().value).toBe("");
    rerender(<AskButton a={{ ...controls, boardId: "o/a" }} repoName="a" />);
    expect(field().value).toBe("on a phone");
  });
});

describe("images in the composer", () => {
  Element.prototype.scrollTo = vi.fn();
  afterEach(() => vi.unstubAllGlobals());

  const picture = () => new File(["x"], "shot.png", { type: "image/png" });
  const pasteOf = (file: File) => ({
    clipboardData: { items: [{ kind: "file", type: file.type, getAsFile: () => file }] },
  });

  /** A server that accepts uploads, optionally holding them until `release` is called. */
  function server({ hold = false } = {}) {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const uploads: FormData[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/projects") return Response.json({ active: { id: "p-1" } });
      if (init?.method === "DELETE") return Response.json({});
      uploads.push(init!.body as FormData);
      if (hold) await gate;
      return Response.json({ attachment: { id: `a-${uploads.length}`, filename: "shot.png", mimeType: "image/png", kind: "image", size: 1, url: "/api/attachments/a-1" } }, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, uploads, release };
  }

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:preview");
    URL.revokeObjectURL = vi.fn();
  });

  it("attaches a pasted screenshot, dimmed until it is uploaded", async () => {
    const s = server({ hold: true });
    render(<AskBox a={controls} repoName="demo" />);
    fireEvent.paste(screen.getByLabelText("Ask the PM"), pasteOf(picture()));
    const thumb = await screen.findByAltText(/pasted-image-\d+\.png/);
    expect(thumb.parentElement).toHaveAttribute("data-status", "uploading");
    expect(thumb.parentElement).toHaveClass("size-12", "rounded-lg", "border-line");
    await act(async () => s.release());
    await waitFor(() => expect(thumb.parentElement).toHaveAttribute("data-status", "done"));
    expect(s.uploads[0]!.get("projectId")).toBe("p-1");
    expect((s.uploads[0]!.get("file") as File).name).toMatch(/^pasted-image-\d+\.png$/);
  });

  it("leaves a paste of plain text to the browser", () => {
    const s = server();
    render(<AskBox a={controls} repoName="demo" />);
    const notPrevented = fireEvent.paste(screen.getByLabelText("Ask the PM"), {
      clipboardData: { items: [{ kind: "string", type: "text/plain", getAsFile: () => null }] },
    });
    expect(notPrevented).toBe(true);
    expect(s.uploads).toHaveLength(0);
  });

  it("removes an attached image before sending", async () => {
    const s = server();
    render(<AskBox a={controls} repoName="demo" />);
    fireEvent.paste(screen.getByLabelText("Ask the PM"), pasteOf(picture()));
    const remove = await screen.findByRole("button", { name: /^Remove pasted-image/ });
    await waitFor(() => expect(screen.getByAltText(/pasted-image/).parentElement).toHaveAttribute("data-status", "done"));
    await userEvent.setup().click(remove);
    expect(screen.queryByAltText(/pasted-image/)).toBeNull();
    expect(s.fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/attachments\/a-1\?requestId=/), { method: "DELETE" });
  });

  it("sends an image with an empty field on Enter, carrying the draft's requestId, and clears the row", async () => {
    const s = server();
    const ask = vi.fn();
    render(<AskBox a={{ ...controls, ask }} repoName="demo" />);
    const box = screen.getByLabelText("Ask the PM");
    fireEvent.paste(box, pasteOf(picture()));
    await waitFor(() => expect(screen.getByAltText(/pasted-image/).parentElement).toHaveAttribute("data-status", "done"));
    await userEvent.setup().type(box, "{Enter}");
    expect(ask).toHaveBeenCalledWith("", undefined, s.uploads[0]!.get("requestId"));
    expect(screen.queryByAltText(/pasted-image/)).toBeNull();
  });

  it.each([
    ["a PDF", new File(["x"], "spec.pdf", { type: "application/pdf" })],
    ["an image over 10 MB", new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.png", { type: "image/png" })],
  ])("refuses %s in muted text without uploading it", async (_, file) => {
    const s = server();
    render(<AskBox a={controls} repoName="demo" />);
    await userEvent.setup({ applyAccept: false }).upload(screen.getByLabelText("Attach an image"), file);
    expect(await screen.findByRole("alert")).toHaveClass("text-muted");
    expect(s.uploads).toHaveLength(0);
  });

  it("refuses a sixth image and keeps the five", async () => {
    server();
    render(<AskBox a={controls} repoName="demo" />);
    const input = screen.getByLabelText("Attach an image");
    await userEvent.setup().upload(input, Array.from({ length: 6 }, (_, i) => new File(["x"], `${i}.png`, { type: "image/png" })));
    expect(await screen.findByRole("alert")).toHaveTextContent("at most 5");
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(5);
  });

  it("shows a sent image in the conversation, enlarges it on tap and closes it on Escape", async () => {
    const attachment = { id: "a-1", filename: "shot.png", mimeType: "image/png", kind: "image" as const, size: 1, url: "/api/attachments/a-1" };
    render(
      <AskBox
        a={{ ...controls, messages: [{ id: "m-1", role: "user", content: "", status: "done", proposals: [], attachments: [attachment] }] }}
        repoName="demo"
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Enlarge shot.png" }));
    expect(screen.getByRole("dialog", { name: "shot.png" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(controls.setOpen).not.toHaveBeenCalledWith(false);
  });
});

describe("selecting in the thread", () => {
  Element.prototype.scrollTo = vi.fn();
  const attr = () => document.documentElement.hasAttribute("data-pm-selecting");
  const a: AssistantControls = {
    ...controls,
    messages: [
      { id: "m1", role: "assistant", content: "hello there", status: "done", proposals: [], cards: [{ id: "c1", key: "T-1", title: "Linked" }] },
    ],
  };

  it("marks the page while a drag that began in the thread lasts", () => {
    render(<AskBox a={a} repoName="demo" />);
    fireEvent.pointerDown(screen.getByText("hello there"), { button: 0 });
    expect(attr()).toBe(true);
    fireEvent.pointerUp(window);
    expect(attr()).toBe(false);
  });

  it("does not mark it for a press on a button or link in the thread", () => {
    render(<AskBox a={a} repoName="demo" />);
    const control = screen.getByTestId("pm-cards").querySelector("button")!;
    fireEvent.pointerDown(control, { button: 0 });
    expect(attr()).toBe(false);
  });

  it("clears the mark on unmount", () => {
    const { unmount } = render(<AskBox a={a} repoName="demo" />);
    fireEvent.pointerDown(screen.getByText("hello there"), { button: 0 });
    unmount();
    expect(attr()).toBe(false);
  });
});
