import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useFocusTrap } from "./use-focus-trap";

function Dialog({ onEscape, children }: { onEscape?: () => void; children: React.ReactNode }) {
  const onKeyDown = useFocusTrap({ onEscape });
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div role="dialog" tabIndex={-1} onKeyDown={onKeyDown} aria-label="d">
      {children}
    </div>
  );
}

function Three() {
  return (
    <Dialog>
      <button>one</button>
      <button disabled>skip</button>
      <button>two</button>
      <button>three</button>
    </Dialog>
  );
}

describe("useFocusTrap", () => {
  it("wraps Tab from the last tabbable element to the first", () => {
    render(<Three />);
    screen.getByText("three").focus();
    fireEvent.keyDown(screen.getByText("three"), { key: "Tab" });
    expect(screen.getByText("one")).toHaveFocus();
  });

  it("wraps Shift+Tab from the first tabbable element to the last", () => {
    render(<Three />);
    screen.getByText("one").focus();
    fireEvent.keyDown(screen.getByText("one"), { key: "Tab", shiftKey: true });
    expect(screen.getByText("three")).toHaveFocus();
  });

  it("leaves Tab alone in the middle of the dialog", () => {
    render(<Three />);
    screen.getByText("two").focus();
    expect(fireEvent.keyDown(screen.getByText("two"), { key: "Tab" })).toBe(true);
  });

  it("keeps focus inside when the dialog itself is focused", () => {
    render(<Three />);
    const dialog = screen.getByRole("dialog");
    dialog.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(screen.getByText("one")).toHaveFocus();
  });

  it("keeps focus on the dialog when nothing is tabbable", () => {
    render(<Dialog>text</Dialog>);
    const dialog = screen.getByRole("dialog");
    dialog.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(dialog).toHaveFocus();
  });

  it("does not let a nested trap's Tab or Escape reach the outer one", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <Dialog onEscape={outer}>
        <button>outer-first</button>
        <Dialog onEscape={inner}>
          <button>inner-only</button>
        </Dialog>
        <button>outer-last</button>
      </Dialog>,
    );
    const button = screen.getByText("inner-only");
    button.focus();
    fireEvent.keyDown(button, { key: "Escape" });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();

    fireEvent.keyDown(button, { key: "Tab" });
    expect(button).toHaveFocus();
  });
});
