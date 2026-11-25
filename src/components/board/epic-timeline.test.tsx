import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { EpicTimeline } from "./epic-timeline";
import { makeCard } from "@/test/cards";

const t = (id: string, status: string, extra = {}) =>
  makeCard({ id, key: id.toUpperCase(), title: `Title ${id}`, status, ...extra } as never);

describe("EpicTimeline", () => {
  it("puts dependencies before the tickets that wait on them", () => {
    render(
      <EpicTimeline
        tickets={[
          t("t2", "ready", { dependsOn: ["t1"] }),
          t("t1", "merged"),
          t("t3", "review", { dependsOn: ["t1"] }),
          t("t4", "running"),
          t("t5", "failed"),
          t("t6", "blocked"),
        ]}
      />,
    );
    const buttons = within(screen.getByLabelText("Epic timeline")).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label")?.split(" ")[0])).toEqual(
      ["T1", "T4", "T5", "T6", "T2", "T3"],
    );
  });

  it("colours each segment and counts by column", () => {
    render(
      <EpicTimeline
        tickets={[
          t("t1", "merged"),
          t("t2", "review"),
          t("t3", "running"),
          t("t4", "ready"),
          t("t5", "failed"),
        ]}
      />,
    );
    const tone = (name: RegExp) =>
      screen.getByRole("button", { name }).firstElementChild;
    expect(tone(/T1/)).toHaveAttribute("data-tone", "done");
    expect(tone(/T1/)).toHaveClass("bg-jade");
    expect(tone(/T2/)).toHaveClass("bg-ochre");
    expect(tone(/T3/)).toHaveClass("bg-ochre", "pulse-dot");
    expect(tone(/T4/)).toHaveClass("bg-sunken");
    expect(tone(/T5/)).toHaveClass("bg-crimson");
    expect(tone(/T2/)).not.toHaveClass("pulse-dot");
    expect(
      screen.getByText("1 merged · 1 in review · 1 in progress · 1 to do · 1 stuck"),
    ).toBeInTheDocument();
  });

  it("shows a ticket with a question as a still plum \"Question\" bar", () => {
    render(
      <EpicTimeline
        tickets={[
          t("t1", "blocked", { blockedReason: "Question: Which database?" }),
          t("t2", "blocked", { blockedReason: "Needs a token" }),
        ]}
      />,
    );
    const bar = screen.getByRole("button", { name: "T1 Title t1: Question" }).firstElementChild;
    expect(bar).toHaveAttribute("data-tone", "plum");
    expect(bar).toHaveClass("bg-plum");
    expect(bar).not.toHaveClass("pulse-dot");
    expect(screen.getByRole("button", { name: "T2 Title t2: Blocked" }).firstElementChild).toHaveClass("bg-crimson");
  });

  it("opens the ticket when its segment is tapped", () => {
    const onOpen = vi.fn();
    render(<EpicTimeline tickets={[t("t1", "merged")]} onOpenTicket={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "T1 Title t1: Merged" }));
    expect(onOpen).toHaveBeenCalledWith("t1");
  });
});
