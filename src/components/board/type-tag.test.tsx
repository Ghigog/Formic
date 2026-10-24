import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TypeTag } from "./type-tag";
import { COLOR_UNLOCKS } from "@/lib/colony/game";
import { tint } from "@/components/ui/tint";
import { BUG_SEVERITIES, WORK_TYPES } from "@/lib/domain/entities";

const NAMES = { user_story: "User story", task: "Task", feature: "Feature", spike: "Spike", tech_debt: "Tech debt", bug: "Bug" } as const;

const TEXT = "#1c1917";

function channels(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** How strong a tint is: its spread between the brightest and dimmest channel. */
function strength(hex: string): number {
  const c = channels(hex);
  return Math.max(...c) - Math.min(...c);
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
    for (const type of ["user_story", "task", "feature", "spike", "tech_debt"] as const) {
      const { unmount } = render(<TypeTag type={type} />);
      colours.add(background());
      unmount();
    }
    expect(colours.size).toBe(5);
  });

  it.each([
    ["user_story", "jade"],
    ["task", "moss"],
    ["feature", "terracotta"],
    ["spike", "ochre"],
  ] as const)("tints a %s tag from the %s insect hex", (type, key) => {
    render(<TypeTag type={type} />);
    expect(background()).toBe(tint(COLOR_UNLOCKS.find((u) => u.key === key)!.hex));
    expect(screen.getByText(/./).style.color).toBe("rgb(28, 25, 23)");
  });

  it("keeps every bug severity on the crimson hue", () => {
    const crimson = channels(COLOR_UNLOCKS.find((u) => u.key === "crimson")!.hex);
    for (const severity of BUG_SEVERITIES) {
      const { unmount } = render(<TypeTag type="bug" severity={severity} />);
      const [r, g, b] = channels(background());
      // a mix with white keeps the channel order of the hue: red above green and blue
      expect(r! > g! && r! > b!).toBe(true);
      expect(crimson[0]! > crimson[1]!).toBe(true);
      unmount();
    }
  });

  it("steps a bug tag up in strength from low to critical", () => {
    const strengths = BUG_SEVERITIES.map((severity) => {
      const { unmount } = render(<TypeTag type="bug" severity={severity} />);
      const v = strength(background());
      unmount();
      return v;
    });
    expect([...strengths].sort((a, b) => a - b)).toEqual(strengths);
    expect(new Set(strengths).size).toBe(4);
  });

  it("keeps black text at 4.5:1 or better on every type and severity", () => {
    const cases = [
      ...(["user_story", "task", "feature", "spike", "tech_debt"] as const).map((type) => ({ type })),
      ...BUG_SEVERITIES.map((severity) => ({ type: "bug" as const, severity })),
    ];
    for (const c of cases) {
      const { unmount } = render(<TypeTag {...c} />);
      const el = screen.getByText(/./);
      expect(el.style.color).toBe("rgb(28, 25, 23)");
      expect(contrast(background(), TEXT)).toBeGreaterThanOrEqual(4.5);
      unmount();
    }
  });

  it("keeps a squashed bug in the muted style", () => {
    render(<TypeTag type="bug" severity="high" squashed />);
    const el = screen.getByText("Squashed");
    expect(el.style.backgroundColor).toBe("");
    expect(el).toHaveClass("text-muted");
  });

  it.each(BUG_SEVERITIES)("reads a %s bug's severity in its label", (severity) => {
    render(<TypeTag type="bug" severity={severity} />);
    const name = severity[0]!.toUpperCase() + severity.slice(1);
    expect(screen.getByText(`Bug · ${name}`)).toHaveAttribute("data-severity", severity);
  });

  it("keeps the plain Bug label without a severity", () => {
    render(<TypeTag type="bug" />);
    expect(screen.getByText("Bug")).toBeInTheDocument();
  });

  it("reads Squashed, without severity, for a done bug", () => {
    render(<TypeTag type="bug" severity="high" squashed />);
    expect(screen.getByText("Squashed")).toBeInTheDocument();
  });
});

describe("a bug's label", () => {
  it("keeps its severity until it is squashed", () => {
    render(<TypeTag type="bug" severity="critical" />);
    expect(screen.getByText("Bug · Critical")).toBeTruthy();
  });

  it("reads Squashed once squashed, whatever its severity", () => {
    render(<TypeTag type="bug" severity="high" squashed />);
    expect(screen.getByText("Squashed")).toBeTruthy();
  });
});
