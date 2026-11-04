import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Meeting } from "@/lib/db/repository";
import { Calendar } from "./calendar";

const from = new Date(2025, 10, 3); // a Monday

const meeting = (repeat: Meeting["repeat"], startsAt = new Date(2025, 10, 3, 9)): Meeting => ({
  id: "m1",
  projectId: "p",
  title: "Stand-up",
  startsAt,
  agenda: "",
  guests: [],
  repeat,
  lastRemindedFor: null,
  createdAt: new Date(0),
});

describe("Calendar", () => {
  it("opens a slot with its time when an empty slot is clicked", async () => {
    const onPick = vi.fn();
    render(<Calendar meetings={[]} from={from} onPick={onPick} />);
    await userEvent.click(screen.getByRole("button", { name: "Wed 5 Nov 10:00" }));
    expect(onPick).toHaveBeenCalledWith(new Date(2025, 10, 5, 10));
  });

  it("shows a meeting in its slot instead of an empty one", () => {
    render(<Calendar meetings={[meeting("none")]} from={from} onPick={() => {}} />);
    expect(screen.getAllByText("Stand-up")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Mon 3 Nov 09:00" })).toBeNull();
  });

  it("shows a weekday meeting in every weekday slot of the two weeks", () => {
    render(<Calendar meetings={[meeting("weekdays")]} from={from} onPick={() => {}} />);
    expect(screen.getAllByText("Stand-up")).toHaveLength(10);
    expect(screen.getByRole("button", { name: "Sat 8 Nov 09:00" })).toBeInTheDocument();
  });
});
