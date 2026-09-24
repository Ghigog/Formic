import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { WorkTimer } from "./card";

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkTimer", () => {
  it("counts up from when the agent started", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T12:02:05Z"));
    render(<WorkTimer since="2026-09-23T12:00:00Z" />);
    expect(screen.getByTitle(/agent has been working/)).toHaveTextContent("2:05");

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByTitle(/agent has been working/)).toHaveTextContent("2:08");
  });

  it("shows nothing while no agent is working", () => {
    const { container } = render(<WorkTimer since={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
