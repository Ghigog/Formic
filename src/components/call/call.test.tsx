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
import { CallProvider, LOOKING_NOW } from "./call-provider";

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
};

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
    vi.fn(async (text: string) => {
      setMessages((m) => [...m, msg(`u${m.length}`, "user", text)]);
    }),
  );
  useEffect(() => {
    controls = { push: setMessages, ask };
  }, [ask]);
  const a: AssistantControls = {
    open: isOpen,
    setOpen,
    presetId: null,
    messages,
    pending:
      messages.at(-1)?.status === "pending" || messages.at(-1)?.role === "user",
    error: null,
    ask,
    stop: vi.fn(),
    clear: vi.fn(),
    decide: vi.fn(),
    setAgent: vi.fn(),
    presets: [],
    onEdit: vi.fn(),
  };
  return (
    <CallProvider assistant={a} engine={engine}>
      <AskBox a={a} repoName="demo" />
      <CallPill assistant={a} />
    </CallProvider>
  );
}

beforeEach(() => {
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
});
