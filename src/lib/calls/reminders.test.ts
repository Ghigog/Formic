import { describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/lib/db/memory-repository";
import { remindDueMeetings } from "./reminders";

async function setup(over: { repeat?: "none" | "weekdays" | "weekly" | "biweekly"; startsAt: Date }) {
  const repo = new MemoryRepository();
  // The memory store is shared by every instance, so start from no meetings.
  for (const { meeting } of await repo.allMeetingsWithOwner()) await repo.deleteMeeting(meeting.id);
  const project = await repo.ensureProject({ ownerId: "owner-1", repoFullName: "acme/calls", baseBranch: "main" });
  const meeting = await repo.createMeeting({ projectId: project.id, title: "Standup", ...over });
  const send = vi.fn(async () => ({ sent: 1, failed: 0 }));
  const tick = (now: Date) => remindDueMeetings(now, { repo, send });
  return { repo, meeting, send, tick };
}

describe("remindDueMeetings", () => {
  it("pushes the owner a link to the call when the meeting starts", async () => {
    const startsAt = new Date("2026-11-02T09:00:00Z");
    const { meeting, send, tick } = await setup({ startsAt });
    await tick(new Date(startsAt.getTime() + 5_000));
    expect(send).toHaveBeenCalledWith("owner-1", expect.objectContaining({ url: `/calls/${meeting.id}` }));
  });

  it("does not remind before the start or long after it", async () => {
    const startsAt = new Date("2026-11-02T09:00:00Z");
    const { send, tick } = await setup({ startsAt });
    await tick(new Date(startsAt.getTime() - 1_000));
    await tick(new Date(startsAt.getTime() + 61_000));
    expect(send).not.toHaveBeenCalled();
  });

  it("reminds once per occurrence when the tick runs twice", async () => {
    const startsAt = new Date("2026-11-02T09:00:00Z");
    const { send, tick } = await setup({ startsAt });
    await tick(new Date(startsAt.getTime() + 5_000));
    await tick(new Date(startsAt.getTime() + 35_000));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reminds a repeating meeting again at its next occurrence", async () => {
    const startsAt = new Date("2026-11-02T09:00:00Z");
    const { send, tick } = await setup({ startsAt, repeat: "weekdays" });
    await tick(new Date("2026-11-02T09:00:10Z"));
    await tick(new Date("2026-11-03T09:00:10Z"));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("skips the weekend for a weekdays meeting", async () => {
    const { send, tick } = await setup({ startsAt: new Date("2026-11-06T09:00:00Z"), repeat: "weekdays" });
    await tick(new Date("2026-11-07T09:00:10Z"));
    await tick(new Date("2026-11-08T09:00:10Z"));
    expect(send).not.toHaveBeenCalled();
  });

  it("repeats weekly and biweekly on their period", async () => {
    const startsAt = new Date("2026-11-02T09:00:00Z");
    const weekly = await setup({ startsAt, repeat: "weekly" });
    await weekly.tick(new Date("2026-11-09T09:00:10Z"));
    expect(weekly.send).toHaveBeenCalledTimes(1);
    const biweekly = await setup({ startsAt, repeat: "biweekly" });
    await biweekly.tick(new Date("2026-11-09T09:00:10Z"));
    expect(biweekly.send).not.toHaveBeenCalled();
    await biweekly.tick(new Date("2026-11-16T09:00:10Z"));
    expect(biweekly.send).toHaveBeenCalledTimes(1);
  });
});
