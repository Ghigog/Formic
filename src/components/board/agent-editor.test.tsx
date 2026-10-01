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
    expect(screen.getByText(/^182\.4k tokens over everything it has run/)).toBeInTheDocument();
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

    expect(screen.getByText(/^0 tokens over everything it has run/)).toBeInTheDocument();
  });

  it("names a renewal window by its start date in the stored timezone, with no Reset", () => {
    stubModelsFetch();
    render(
      <AgentEditor
        column="in_progress"
        preset={saved()}
        usage={{ tokensIn: 3_000_000, tokensOut: 200_000 }}
        window={{ kind: "renewal", since: "2026-09-05T04:00:00.000Z", timezone: "America/New_York" }}
        onResetWindow={vi.fn()}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText(/^3\.20M tokens since 5 September/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
  });

  it("offers Reset with no renewal day, and calls it", async () => {
    stubModelsFetch();
    const onResetWindow = vi.fn(async () => {});
    render(
      <AgentEditor
        column="in_progress"
        preset={saved()}
        usage={{ tokensIn: 10, tokensOut: 5 }}
        window={{ kind: "reset", since: "2026-09-30T12:00:00.000Z", timezone: "UTC" }}
        onResetWindow={onResetWindow}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText(/^15 tokens since you reset it on 30 September/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(onResetWindow).toHaveBeenCalled();
  });

  it("says a CLI agent's provider reports no tokens", () => {
    stubModelsFetch();
    render(
      <AgentEditor
        column="in_progress"
        preset={saved({ provider: "claude-code" as AgentPreset["provider"] })}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText("Its provider reports no tokens.")).toBeInTheDocument();
    expect(screen.queryByText(/tokens over/)).not.toBeInTheDocument();
  });

  it("counts nothing for a new agent, which has not run yet", () => {
    stubModelsFetch();
    render(
      <AgentEditor column="in_progress" preset={null} onClose={vi.fn()} onSave={vi.fn()} onDelete={vi.fn()} />,
    );

    expect(screen.queryByText(/tokens over/)).not.toBeInTheDocument();
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

    expect(screen.getByText(/bounds token volume, not a bill.*OpenAI gpt-4o/)).toBeInTheDocument();
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

describe("AgentEditor limit override", () => {
  const preset = (provider: string): AgentPreset =>
    ({
      id: "p1",
      name: "worker",
      provider,
      model: "m",
      prompt: "",
      column: "todo",
      hasKey: true,
      keyHint: "1234",
      limitedUntil: null,
      limitNote: null,
    }) as AgentPreset;

  it("offers flat values for minutes, tokens and attempts and saves them", async () => {
    stubModelsFetch();
    const onSaveOverride = vi.fn(async () => {});
    render(
      <AgentEditor
        column="todo"
        preset={preset("anthropic")}
        override={{ minutes: 15, tokens: null, attempts: null }}
        onSaveOverride={onSaveOverride}
        onClose={vi.fn()}
        onSave={vi.fn(async () => {})}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Minutes override")).toHaveValue(15);
    await userEvent.type(screen.getByLabelText("Attempts override"), "3");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSaveOverride).toHaveBeenCalledWith({ minutes: 15, tokens: null, attempts: 3 });
  });

  it("offers no token limit to an agent whose path cannot enforce one", () => {
    stubModelsFetch();
    render(
      <AgentEditor
        column="todo"
        preset={preset("claude-code")}
        onSaveOverride={vi.fn()}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Minutes override")).toBeInTheDocument();
    expect(screen.queryByLabelText("Tokens override")).not.toBeInTheDocument();
  });
});
