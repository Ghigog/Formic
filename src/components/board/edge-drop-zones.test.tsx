import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import type { ColumnId } from "@/lib/domain/status";
import { renderInDnd } from "@/test/render";
import { EDGE_NEXT_ID, EDGE_PREVIOUS_ID, EdgeDropZones, edgeDestination, edgeTargets } from "./edge-drop-zones";

const allow = () => true;

describe("edgeDestination", () => {
  it("resolves the left edge to the next column and the right to the previous", () => {
    expect(edgeDestination(EDGE_NEXT_ID, "todo")).toBe("in_progress");
    expect(edgeDestination(EDGE_PREVIOUS_ID, "todo")).toBe("backlog");
  });

  it("is null for anything else", () => {
    expect(edgeDestination("archive", "todo")).toBeNull();
    expect(edgeDestination("todo", "todo")).toBeNull();
  });
});

describe("edgeTargets", () => {
  it("offers both neighbours from a middle column", () => {
    expect(edgeTargets("todo", "todo", allow)).toEqual({ next: "in_progress", previous: "backlog" });
  });

  it("offers no previous from Backlog and no next from Done", () => {
    expect(edgeTargets("backlog", "backlog", allow).previous).toBeNull();
    expect(edgeTargets("done", "done", allow).next).toBeNull();
  });

  it("offers no side the rules refuse", () => {
    const only = (to: ColumnId) => (_from: ColumnId, dest: ColumnId) => dest === to;
    expect(edgeTargets("todo", "todo", only("backlog"))).toEqual({ next: null, previous: "backlog" });
  });
});

describe("EdgeDropZones", () => {
  const bar = (name: string) => screen.getByRole("region", { name }).firstElementChild!;

  it("labels each side with its destination column", () => {
    renderInDnd(<EdgeDropZones dragging next="in_progress" previous="backlog" />);
    expect(bar("Move to In Progress")).toHaveTextContent("In Progress");
    expect(bar("Move to Backlog")).toHaveTextContent("Backlog");
    expect(bar("Move to In Progress")).not.toHaveAttribute("data-over");
  });

  it("is hidden until a drag starts", () => {
    renderInDnd(<EdgeDropZones dragging={false} next="in_progress" previous="backlog" />);
    expect(bar("Move to In Progress")).toHaveAttribute("aria-hidden", "true");
  });

  it("renders no zone for a side that is not offered", () => {
    renderInDnd(<EdgeDropZones dragging next={null} previous="backlog" />);
    expect(screen.queryByRole("region", { name: /In Progress/ })).toBeNull();
    expect(bar("Move to Backlog")).not.toHaveAttribute("aria-hidden");
  });
});
