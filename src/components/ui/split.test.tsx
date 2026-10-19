import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { setViewportMatches } from "@/test/viewport";
import { SideBySide, WithChat } from "./split";

/**
 * The chat under a drawer's log: its divider resizes it, and the size is
 * remembered in this browser for the next time the drawer opens.
 */
describe("WithChat", () => {
  afterEach(() => window.localStorage.clear());

  it("grows the chat when the divider moves up, and remembers it", () => {
    const { unmount } = render(
      <WithChat storageKey="test" chat={<p>chat</p>}>
        <p>log</p>
      </WithChat>,
    );
    const divider = screen.getByRole("separator", { name: "Resize the chat" });
    expect(divider).toHaveAttribute("aria-valuenow", "280");

    fireEvent.keyDown(divider, { key: "ArrowUp" });
    const grown = Number(divider.getAttribute("aria-valuenow"));
    expect(grown).toBeGreaterThan(280);
    unmount();

    render(
      <WithChat storageKey="test" chat={<p>chat</p>}>
        <p>log</p>
      </WithChat>,
    );
    expect(screen.getByRole("separator", { name: "Resize the chat" })).toHaveAttribute("aria-valuenow", String(grown));
  });

  it("shows no divider when there is no chat", () => {
    render(
      <WithChat storageKey="test" chat={null}>
        <p>log</p>
      </WithChat>,
    );
    expect(screen.queryByRole("separator")).toBeNull();
  });
});

/** Two panes side by side from 1024px up; each keeps a readable width. */
describe("SideBySide", () => {
  afterEach(() => {
    window.localStorage.clear();
    setViewportMatches(false);
  });

  const panes = () => <SideBySide storageKey="test" active="first" first={<p>left</p>} second={<p>right</p>} />;

  it("clamps an extreme saved width, and keeps a pixel minimum on both panes", () => {
    setViewportMatches(true);
    window.localStorage.setItem("formic:test:width", "3");
    render(panes());
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "25");
    const left = screen.getByText("left").parentElement!;
    expect(left.style.width).toBe("25%");
    expect(left.style.minWidth).toBe("120px");
    expect(left.style.maxWidth).toBe("calc(100% - 120px)");
    expect(screen.getByText("right").parentElement!.style.minWidth).toBe("120px");
  });

  it("clamps a saved width that is too large", () => {
    setViewportMatches(true);
    window.localStorage.setItem("formic:test:width", "99");
    render(panes());
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "75");
  });

  it("stops the divider at either end", () => {
    setViewportMatches(true);
    render(panes());
    const divider = screen.getByRole("separator");
    for (let i = 0; i < 30; i++) fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(divider).toHaveAttribute("aria-valuenow", "25");
    for (let i = 0; i < 30; i++) fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(divider).toHaveAttribute("aria-valuenow", "75");
  });

  it("shows only the active pane below the breakpoint", () => {
    render(panes());
    expect(screen.getByText("left")).toBeInTheDocument();
    expect(screen.queryByText("right")).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
  });
});
