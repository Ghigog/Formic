import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { AskBox, type AssistantControls } from "@/components/board/assistant";
import {
  silenceMutter,
  mutter,
  attachVoice,
} from "@/components/onboarding/voice";
import { FakeEngine } from "@/lib/voice/engine";
import type { AssistantMessageView } from "@/lib/hooks/use-assistant";
import { CallPill } from "./call-pill";
import { AgentCallButton } from "./agent-call-button";
import { CallProvider, LOOKING_NOW, useCall } from "./call-provider";

const msg = (
  id: string,
  role: "user" | "assistant",
  content: string,
  status: "done" | "pending" = "done",
): AssistantMessageView => ({
  id,
  role,
  content,
  status,
  proposals: [],
});

/** A stand-in for useAssistant that the test drives. */
let controls: {
  push: (m: AssistantMessageView[]) => void;
  ask: ReturnType<typeof vi.fn>;
  decide: ReturnType<typeof vi.fn>;
  openCall: ReturnType<typeof vi.fn>;
};

/** What the chat holds once it loads, which happens after the call has started. */
let history: AssistantMessageView[] = [];

function MeetingButton() {
  const call = useCall();
  return (
    <button onClick={() => call?.startMeeting({ id: "mt-1", guests: ["assistant", "coder", "reviewer"] })}>
      join meeting
    </button>
  );
}

function Harness({
  engine,
  open = true,
}: {
  engine: FakeEngine;
  open?: boolean;
}) {
  const [messages, setMessages] = useState<AssistantMessageView[]>([]);
  const [isOpen, setOpen] = useState(open);
  const [ask] = useState(() =>
    vi.fn(async (text: string, _speakers?: string[]) => {
      setMessages((m) => [...m, msg(`u${m.length}`, "user", text)]);
    }),
  );
  const [decide] = useState(() => vi.fn(async () => {}));
  const [openCall] = useState(() => vi.fn(async (_meetingId?: string) => {}));
  useEffect(() => {
    controls = { push: setMessages, ask, decide, openCall };
  }, [ask, decide, openCall]);
  const load = async () => {
    setMessages(history);
    return history;
  };
  const a: AssistantControls = {
    load,
    open: isOpen,
    setOpen,
    presetId: null,
    messages,
    pending:
      messages.at(-1)?.status === "pending" || messages.at(-1)?.role === "user",
    error: null,
    ask,
    openCall,
    stop: vi.fn(),
    clear: vi.fn(),
    decide,
    setAgent: vi.fn(),
    presets: [],
    onEdit: vi.fn(),
  };
  return (
    <CallProvider assistant={a} engine={engine}>
      <AskBox a={a} repoName="demo" />
      <CallPill assistant={a} />
      <AgentCallButton guest="reviewer" />
      <MeetingButton />
    </CallProvider>
  );
}

beforeEach(() => {
  history = [];
  Element.prototype.scrollTo = vi.fn();
});
afterEach(() => silenceMutter(false));

describe("a call on the PM chat", () => {
  it("shows the PM, a timer and a listening mic when the phone is tapped", async () => {
    const engine = new FakeEngine();
    render(<Harness engine={engine} />);
    await userEvent.click(screen.getByRole("button", { name: "Call the PM" }));
    expect(engine.live).toBe(true);
    expect(screen.getByText(/On a call with PM/)).toBeInTheDocument();
    expect(screen.getByTestId("call-elapsed")).toHaveTextContent("0:00");
    expect(screen.getByTestId("call-mic")).toHaveAttribute(
      "data-state",
      "listening",
    );
  });

  it("starts a meeting: all its guests on the bar and the PM opening it with the meeting", async () => {
    const engine = new FakeEngine();
    render(<Harness engine={engine} />);
    await userEvent.click(screen.getByText("join meeting"));
    expect(engine.live).toBe(true);
    expect(controls.openCall).toHaveBeenCalledWith("mt-1");
    expect(screen.getByText(/On a call with PM, Coder, Reviewer/)).toBeInTheDocument();
  });

  it("disables the phone, saying why, when speech is not supported", () => {
    const engine = new FakeEngine();
    engine.supported = false;
    render(<Harness engine={engine} />);
    const phone = screen.getByRole("button", { name: "Call the PM" });
    expect(phone).toBeDisabled();
    expect(phone).toHaveAttribute(
      "title",
      expect.stringContaining("speech recognition"),
    );
  });

  it("sends what is said and reads the reply aloud once", async () => {
    const engine = new FakeEngine();
    render(<Harness engine={engine} />);
    await userEvent.click(screen.getByRole("button", { name: "Call the PM" }));
    await act(async () => engine.say("What is the status?"));
    expect(controls.ask).toHaveBeenCalledWith("What is the status?");
    act(() =>
      controls.push([
        msg("u0", "user", "What is the status?"),
        msg("a1", "assistant", "Two tickets are **running**."),
      ]),
    );
    expect(engine.spoken.at(-1)).toBe("Two tickets are running.");
    act(() =>
      controls.push([
        msg("u0", "user", "What is the status?"),
        msg("a1", "assistant", "Two tickets are **running**."),
      ]),
    );
    expect(engine.spoken.filter((s) => s.startsWith("Two"))).toHaveLength(1);
  });

  it("says Looking now once per wait and queues the next message behind the answer", async () => {
    const engine = new FakeEngine();
    render(<Harness engine={engine} />);
    await userEvent.click(screen.getByRole("button", { name: "Call the PM" }));
    await act(async () => engine.say("First"));
    await act(async () => engine.say("Second"));
    expect(engine.spoken.filter((s) => s === LOOKING_NOW)).toHaveLength(1);
    expect(controls.ask).toHaveBeenCalledTimes(1);
    act(() =>
      controls.push([
        msg("u0", "user", "First"),
        msg("a1", "assistant", "Done."),
      ]),
    );
    expect(controls.ask).toHaveBeenCalledTimes(2);
    expect(controls.ask).toHaveBeenLastCalledWith("Second");
  });

  it("reads a proposal, takes a spoken yes as Approve, and asks for 'yes, merge it' to merge", async () => {
    const engine = new FakeEngine();
    render(<Harness engine={engine} />);
    await userEvent.click(screen.getByRole("button", { name: "Call the PM" }));
    await act(async () => engine.say("Add a ticket"));
    const proposal = (action: { type: "move_card" }, summary: string) => ({
      ...msg("a1", "assistant", "Here you go."),
      proposals: [{ summary, action, state: "proposed" as const }],
    });
    act(() =>
      controls.push([
        msg("u0", "user", "Add a ticket"),
        proposal({ type: "move_card", key: "T-1", to: "done" } as { type: "move_card" }, "Move T-1 to Done"),
      ]),
    );
    expect(engine.spoken.at(-1)).toBe("Move T-1 to Done. Shall I?");
    await act(async () => engine.say("yes"));
    expect(controls.decide).not.toHaveBeenCalled();
    expect(controls.ask).toHaveBeenCalledTimes(1);
    expect(engine.spoken.at(-1)).toBe("Say 'yes, merge it' to merge.");
    await act(async () => engine.say("yes, merge it"));
    expect(controls.decide).toHaveBeenCalledWith("a1", 0, "apply");
    expect(controls.ask).toHaveBeenCalledTimes(1);
  });

  it("keeps the call in a pill while the chat is closed, and ends it on hang up", async () => {
    const engine = new FakeEngine();
    render(<Harness engine={engine} />);
    await userEvent.click(screen.getByRole("button", { name: "Call the PM" }));
    await userEvent.click(
      screen.getAllByRole("button", { name: "Roll the PM up" })[0]!,
    );
    const pill = screen.getByRole("button", {
      name: /On a call with PM, 0:00/,
    });
    await userEvent.click(pill);
    expect(screen.queryByRole("button", { name: /Open the chat/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Hang up" }));
    expect(engine.live).toBe(false);
    expect(screen.queryByTestId("call-mic")).toBeNull();
  });

  it("silences the ant's mutter while live, and lets it back after", async () => {
    const detach = attachVoice();
    const engine = new FakeEngine();
    render(<Harness engine={engine} />);
    const spy = vi.spyOn(
      await import("@/components/colony/sound").then(
        (m) => m.SoundEngine.prototype,
      ),
      "syllable",
    );
    mutter("a");
    const before = spy.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Call the PM" }));
    mutter("a");
    expect(spy.mock.calls.length).toBe(before);
    await userEvent.click(screen.getByRole("button", { name: "Hang up" }));
    mutter("a");
    expect(spy.mock.calls.length).toBe(before + 1);
    detach();
    spy.mockRestore();
  });

  it("brings a guest in by voice, then sends questions to the last speaker, lit while it answers", async () => {
    const engine = new FakeEngine();
    render(<Harness engine={engine} />);
    await userEvent.click(screen.getByRole("button", { name: "Call the PM" }));
    await act(async () => engine.say("get the Reviewer in"));
    expect(screen.getByTestId("call-guest-reviewer")).toBeInTheDocument();
    expect(controls.ask).not.toHaveBeenCalled();
    await act(async () => engine.say("Reviewer, how are the tests?"));
    expect(controls.ask).toHaveBeenLastCalledWith("Reviewer, how are the tests?", ["reviewer"]);
    act(() =>
      controls.push([
        msg("u0", "user", "Reviewer, how are the tests?"),
        { ...msg("a1", "assistant", "", "pending"), speaker: "reviewer" },
      ]),
    );
    expect(screen.getByTestId("call-guest-reviewer")).toHaveAttribute("data-active", "true");
    act(() =>
      controls.push([
        msg("u0", "user", "Reviewer, how are the tests?"),
        { ...msg("a1", "assistant", "Green."), speaker: "reviewer" },
      ]),
    );
    await act(async () => engine.say("and the lint?"));
    expect(controls.ask).toHaveBeenLastCalledWith("and the lint?", ["reviewer"]);
  });

  it("greets everyone: every guest in order, each asked for a one-line hello", async () => {
    const engine = new FakeEngine();
    render(<Harness engine={engine} />);
    await userEvent.click(screen.getByRole("button", { name: "Call the PM" }));
    await act(async () => engine.say("get the Reviewer in"));
    await act(async () => engine.say("hello everyone"));
    const [text, speakers] = controls.ask.mock.calls.at(-1)!;
    expect(text).toMatch(/^hello everyone.*one-line hello/);
    expect(speakers).toEqual(["assistant", "reviewer"]);
  });

  it("opens the call with an agent as the first guest from its phone", async () => {
    const engine = new FakeEngine();
    render(<Harness engine={engine} />);
    await userEvent.click(screen.getByRole("button", { name: "Call the Reviewer" }));
    expect(engine.live).toBe(true);
    expect(screen.getByTestId("call-guest-reviewer")).toBeInTheDocument();
  });

  it("does not read old replies that load after the call starts; the first thing spoken is the answer to the greeting", async () => {
    history = [
      msg("u0", "user", "Earlier question"),
      msg("a0", "assistant", "An old PM reply."),
      { ...msg("a1", "assistant", "An old architect reply."), speaker: "architect" },
    ];
    const engine = new FakeEngine();
    render(<Harness engine={engine} />);
    await userEvent.click(screen.getByRole("button", { name: "Call the Reviewer" }));
    expect(controls.ask).toHaveBeenCalledWith("Hello!", ["reviewer"]);
    act(() =>
      controls.push([
        ...history,
        msg("u1", "user", "Hello!"),
        { ...msg("a2", "assistant", "Hi, I am the reviewer."), speaker: "reviewer" },
      ]),
    );
    expect(engine.spoken.some((t) => t.includes("old"))).toBe(false);
    expect(engine.spoken.at(-1)).toBe("Hi, I am the reviewer.");
  });

  it("reads a failed reply to a turn of this call as the guest's couldn't answer", async () => {
    const engine = new FakeEngine();
    render(<Harness engine={engine} />);
    await userEvent.click(screen.getByRole("button", { name: "Call the Reviewer" }));
    await act(async () => engine.say("Is it ready?"));
    act(() =>
      controls.push([
        msg("u0", "user", "Is it ready?"),
        {
          ...msg("a1", "assistant", "This agent runs out of time.", "done"),
          status: "failed",
          speaker: "reviewer",
        },
      ]),
    );
    expect(engine.spoken.at(-1)).toBe("Reviewer couldn't answer: This agent runs out of time.");
  });
});
