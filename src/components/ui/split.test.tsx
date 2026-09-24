import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WithChat } from "./split";

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
    expect(screen.getByRole("separator", { name: "Resize the chat" })).toHaveAttribute(
      "aria-valuenow",
      String(grown),
    );
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
