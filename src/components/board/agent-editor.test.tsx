import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentEditor } from "./agent-editor";

afterEach(() => vi.unstubAllGlobals());

function stubModelsFetch() {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, models: [] })));
}

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

  it("says a model with no known price is charged a conservative default", async () => {
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

    expect(screen.getByText(/No known price for/)).toBeInTheDocument();
    expect(screen.getByText(/conservative default/)).toBeInTheDocument();
  });
});
