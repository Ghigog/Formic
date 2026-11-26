import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SwapHint } from "./swap-hint";

beforeEach(() => {
  Object.assign(window, { innerWidth: 390, innerHeight: 800 });
});
afterEach(() => Object.assign(window, { innerWidth: 1024, innerHeight: 768 }));

const touch = (x: number, y: number, armed = false) => ({ x, y, armed, touch: true as const });

describe("SwapHint for a swipe", () => {
  it("draws a guide line at the release height and the coin away from the fingers", () => {
    const { rerender } = render(<SwapHint aim={touch(100, 500)} />);
    expect(screen.getByTestId("swap-hint-line").style.top).toBe("500px");
    expect(screen.getByTestId("swap-hint").style.right).toBe("16px");
    expect(screen.getByTestId("swap-hint").textContent).toContain("Release here to switch boards");
    rerender(<SwapHint aim={touch(300, 500)} />);
    expect(screen.getByTestId("swap-hint").style.left).toBe("16px");
  });

  it("turns terracotta once armed", () => {
    render(<SwapHint aim={touch(100, 500, true)} />);
    expect(screen.getByTestId("swap-hint-line").className).toContain("bg-terracotta");
  });

  it("stays on screen: below the app bar and above the bottom edge", () => {
    const { rerender } = render(<SwapHint aim={touch(100, -40)} />);
    expect(screen.getByTestId("swap-hint-line").style.top).toBe("64px");
    rerender(<SwapHint aim={touch(100, 2000)} />);
    expect(Number.parseInt(screen.getByTestId("swap-hint-line").style.top)).toBeLessThan(800);
  });

  it("still hides a right-button aim above the window", () => {
    render(<SwapHint aim={{ x: 100, y: -5, armed: false }} />);
    expect(screen.queryByTestId("swap-hint")).toBeNull();
  });
});
