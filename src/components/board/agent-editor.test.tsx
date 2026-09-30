import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentEditor } from "./agent-editor";
import type { AgentPreset } from "@/lib/domain/entities";

afterEach(() => vi.unstubAllGlobals());

function stubModelsFetch() {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, models: [] })));
}

describe("AgentEditor tokens used", () => {
  const saved = (over: Partial<AgentPreset> = {}): AgentPreset =>
    ({
      id: "p1",
      name: "claude-worker",
      provider: "anthropic",
      model: "claude-sonnet-5",
      prompt: "",
      column: "in_progress",
      hasKey: true,
      keyHint: "1234",
      limitedUntil: null,
      limitNote: null,
      ...over,
    }) as AgentPreset;

  it("says what a saved agent has used, in tokens, and no money at all", () => {
    stubModelsFetch();
    render(
      <AgentEditor
        column="in_progress"
        preset={saved()}
        usage={{ tokensIn: 141_200, tokensOut: 41_200 }}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    // Tokens, not cents: a flat plan bills none, and the price table is a
    // hand-kept estimate (see docs/token-usage.md).
    expect(screen.getByText("182.4k tokens used by this agent, over its finished runs and its answers.")).toBeInTheDocument();
    expect(screen.queryByText(/¢/)).not.toBeInTheDocument();
  });

  it("says nothing has been used for an agent that has run nothing", () => {
    stubModelsFetch();
    render(
      <AgentEditor
        column="in_progress"
        preset={saved()}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText("No tokens used by this agent yet.")).toBeInTheDocument();
  });

  it("counts nothing for a new agent, which has not run yet", () => {
    stubModelsFetch();
    render(
      <AgentEditor column="in_progress" preset={null} onClose={vi.fn()} onSave={vi.fn()} onDelete={vi.fn()} />,
    );

    expect(screen.queryByText(/tokens used by this agent/)).not.toBeInTheDocument();
  });
});

describe("AgentEditor pricing note", () => {
  it("says how a known-price model will be billed against the budget", async () => {
    stubModelsFetch();
    render(
      <AgentEditor
        column="in_progress"
        preset={null}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    await act(async () => {
      await new Promise(requestAnimationFrame);
    });
    const user = userEvent.setup();
    await act(async () => {
      await user.click(screen.getByLabelText("Model"));
      await user.type(screen.getByLabelText("Model"), "gpt-4o");
    });

    expect(screen.getByText(/Billed as OpenAI gpt-4o/)).toBeInTheDocument();
  });

  it("says a model with no known price is not counted against the ceiling", async () => {
    stubModelsFetch();
    render(
      <AgentEditor
        column="in_progress"
        preset={null}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    await act(async () => {
      await new Promise(requestAnimationFrame);
    });
    const user = userEvent.setup();
    await act(async () => {
      await user.click(screen.getByLabelText("Model"));
      await user.type(screen.getByLabelText("Model"), "some-brand-new-model");
    });

    expect(screen.getByText(/No price known for/)).toBeInTheDocument();
    expect(screen.getByText(/not counted against the spend ceiling/)).toBeInTheDocument();
  });
});
