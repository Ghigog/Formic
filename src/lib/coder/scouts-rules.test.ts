import { beforeEach, describe, expect, it } from "vitest";
import { repository } from "@/lib/db";
import type { TicketDetail } from "@/lib/db/repository";
import { MockVcsClient, resetVcs, setVcs } from "@/lib/vcs";
import {
  SCOUT_APPROACHES,
  SCOUT_APPROACH_NAMES,
  approachName,
  recallScouts,
  scoutViews,
  scouting,
  sendScouts,
  swapScout,
} from "./scouts";

/** The rules of scouts that need no run: who may be sent, swapped and recalled. */

const PROJECT = "project_default";

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  MockVcsClient.reset();
  resetVcs();
  setVcs(new MockVcsClient("acme/widgets"));
});

async function tickets(...keys: string[]) {
  const repo = repository();
  const epic = await repo.createEpic({ projectId: PROJECT, title: "Db", rawRequest: "Db", position: 1 });
  return repo.createTickets(
    keys.map((key, i) => ({
      epicId: epic.id,
      key,
      title: key,
      description: key,
      acceptanceCriteria: ["a"],
      fileScope: [`src/${key}`],
      size: "S" as const,
      position: i + 1,
      dependsOnKeys: i === 1 ? [keys[0]!] : [],
    })),
  );
}

describe("approachName", () => {
  it("names the briefs scouts are given, and any other as their own", () => {
    SCOUT_APPROACHES.forEach((brief, i) => expect(approachName(brief)).toBe(SCOUT_APPROACH_NAMES[i]));
    expect(approachName("something else")).toBe("own approach");
    expect(approachName(null)).toBe("own approach");
  });
});

describe("scouting", () => {
  it("is for a ticket with scouts out, no pick and no pull request", () => {
    const base = { scoutOf: null, scouts: 2, scoutPick: null, prNumber: null } as unknown as TicketDetail;
    expect(scouting(base)).toBe(true);
    expect(scouting({ ...base, scoutOf: "p" })).toBe(false);
    expect(scouting({ ...base, scouts: 0 })).toBe(false);
    expect(scouting({ ...base, scoutPick: "s" })).toBe(false);
    expect(scouting({ ...base, prNumber: 3 })).toBe(false);
  });
});

describe("sendScouts refusals", () => {
  it("refuses an unknown ticket, a person's ticket, and one waiting on an open dependency", async () => {
    const repo = repository();
    expect(await sendScouts(PROJECT, "nope")).toEqual({ ok: false, reason: "That ticket is not on this board." });
    const [a, b] = await tickets("T-1", "T-2");
    expect(await sendScouts("other-project", a!.id)).toMatchObject({ ok: false });

    await repo.updateTicket(b!.id, { status: "failed", stalledIn: "in_progress" });
    expect(await sendScouts(PROJECT, b!.id)).toEqual({
      ok: false,
      reason: "Scouts go out once everything the ticket depends on has merged.",
    });

    await repo.updateTicket(a!.id, { status: "failed", stalledIn: "in_progress", needsHuman: true } as never);
    const answer = await sendScouts(PROJECT, a!.id);
    expect(answer.ok).toBe(false);
  });
});

describe("swapScout refusals", () => {
  it("refuses an unknown ticket, one with no pick, the same pick, and a scout with no change", async () => {
    const repo = repository();
    const [t] = await tickets("T-1");
    expect(await swapScout(PROJECT, "nope", "x")).toEqual({ ok: false, reason: "That ticket is not on this board." });
    expect(await swapScout("other", t!.id, "x")).toMatchObject({ ok: false });
    expect(await swapScout(PROJECT, t!.id, "x")).toEqual({ ok: false, reason: "There is no pick to swap." });

    await repo.createScouts(t!.id, [{ brief: SCOUT_APPROACHES[0], presetId: null }]);
    const [scout] = await repo.scoutsOf(t!.id);
    await repo.updateTicket(t!.id, { scouts: 1, scoutPick: scout!.id, status: "review" });
    expect(await swapScout(PROJECT, t!.id, scout!.id)).toEqual({ ok: true });
    expect(await swapScout(PROJECT, t!.id, "missing")).toEqual({
      ok: false,
      reason: "That scout came back without a change.",
    });

    await repo.updateTicket(t!.id, { scoutPick: "someone-else" });
    await repo.updateTicket(scout!.id, { status: "review", branchName: "formic/s1" });
    await repo.updateTicket(t!.id, { status: "running" });
    expect(await swapScout(PROJECT, t!.id, scout!.id)).toEqual({
      ok: false,
      reason: "Wait for the Coder Agent working on it to finish.",
    });
  });
});

describe("recallScouts and scoutViews", () => {
  it("fails the scouts still out, clears the ticket, and shows each scout as out, back or empty", async () => {
    const repo = repository();
    const [t] = await tickets("T-1");
    await repo.createScouts(t!.id, [
      { brief: SCOUT_APPROACHES[0], presetId: null },
      { brief: SCOUT_APPROACHES[1], presetId: null },
      { brief: "custom", presetId: null },
    ]);
    const [s1, s2, s3] = await repo.scoutsOf(t!.id);
    await repo.updateTicket(t!.id, { scouts: 3, scoutPick: s2!.id, scoutWhy: "It has tests." });
    await repo.updateTicket(s1!.id, { status: "running" });
    await repo.updateTicket(s2!.id, { status: "review", summary: "small" });
    await repo.updateTicket(s3!.id, { status: "failed", blockedReason: "No way." });

    const view = await scoutViews(t!.id);
    expect(view.why).toBe("It has tests.");
    expect(view.scouts.map((s) => [s.status, s.picked, s.reason])).toEqual([
      ["out", false, null],
      ["back", true, null],
      ["empty", false, "No way."],
    ]);
    expect(view.scouts[2]!.approach).toBe("own approach");

    await recallScouts(PROJECT, t!.id);
    expect((await repo.ticketDetail(s1!.id))!.status).toBe("failed");
    expect(await repo.ticketDetail(t!.id)).toMatchObject({ scouts: 0, scoutPick: null, scoutWhy: null });
    expect((await scoutViews("none")).scouts).toEqual([]);
  });
});
