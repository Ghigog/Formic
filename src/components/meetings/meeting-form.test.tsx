import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MeetingForm } from "./meeting-form";

const guests = [
  { id: "assistant" as const, label: "PM" },
  { id: "coder" as const, label: "Coder" },
];
const at = new Date(2025, 10, 5, 10);

describe("MeetingForm", () => {
  it("fills the title and a starter agenda from a quick pick, and the agenda stays editable", async () => {
    render(<MeetingForm at={at} guests={guests} onSave={async () => {}} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Retro" }));
    expect(screen.getByLabelText("Title")).toHaveValue("Retro");
    const agenda = screen.getByLabelText("Agenda") as HTMLTextAreaElement;
    expect(agenda.value).toContain("What went well");
    await userEvent.type(agenda, " and more");
    expect(agenda.value).toContain("and more");
  });

  it("swaps the starter agenda between picks but keeps one the person wrote", async () => {
    render(<MeetingForm at={at} guests={guests} onSave={async () => {}} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Standup" }));
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    expect((screen.getByLabelText("Agenda") as HTMLTextAreaElement).value).toContain("Demo what merged");
    await userEvent.type(screen.getByLabelText("Agenda"), "!");
    await userEvent.click(screen.getByRole("button", { name: "Retro" }));
    expect((screen.getByLabelText("Agenda") as HTMLTextAreaElement).value).toContain("Demo what merged");
  });

  it("saves the slot, repeat and guests", async () => {
    const onSave = vi.fn(async () => {});
    render(<MeetingForm at={at} guests={guests} onSave={onSave} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Standup" }));
    await userEvent.click(screen.getByLabelText("Coder"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ title: "Standup", startsAt: at, guests: ["coder"], repeat: "none" }));
  });
});
