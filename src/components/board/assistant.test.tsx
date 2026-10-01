import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { AskBox, type AssistantControls } from "./assistant";

const controls: AssistantControls = {
  open: true,
  setOpen: vi.fn(),
  presetId: null,
  messages: [],
  pending: false,
  error: null,
  ask: vi.fn(),
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
});
