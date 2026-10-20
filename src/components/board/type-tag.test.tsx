import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TypeTag } from "./type-tag";
import { BUG_SEVERITIES, WORK_TYPES } from "@/lib/domain/entities";

const NAMES = { user_story: "User story", task: "Task", feature: "Feature", spike: "Spike", bug: "Bug" } as const;

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function background(): string {
  const el = screen.getByText(/./);
  const c = el.style.backgroundColor.match(/\d+/g)!.map(Number);
  return "#" + c.map((n) => n.toString(16).padStart(2, "0")).join("");
}

describe("TypeTag", () => {
  it.each(WORK_TYPES)("labels a %s tag", (type) => {
    render(<TypeTag type={type} />);
    expect(screen.getByText(NAMES[type])).toHaveAttribute("data-type-tag", type);
  });

  it("gives each non-bug type its own colour", () => {
    const colours = new Set<string>();
    for (const type of ["user_story", "task", "feature", "spike"] as const) {
      const { unmount } = render(<TypeTag type={type} />);
      colours.add(background());
      unmount();
    }
    expect(colours.size).toBe(4);
  });

  it("darkens a bug tag from low to critical", () => {
    const lums = BUG_SEVERITIES.map((severity) => {
      const { unmount } = render(<TypeTag type="bug" severity={severity} />);
      const l = luminance(background());
      unmount();
      return l;
    });
    expect([...lums].sort((a, b) => b - a)).toEqual(lums);
    expect(new Set(lums).size).toBe(4);
  });
});
