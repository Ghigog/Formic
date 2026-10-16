import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/fixtures/board", () => ({ FIXTURE_CARDS: [], FIXTURE_TICKET_DETAILS: {} }));

const { repository } = await import("@/lib/db");
const { rateNote, sharedNotes, sharedNotesFor, shareNote, sharedNoteLine } = await import("./shared-notes");

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
});

async function ticketOn(projectId: string, key: string) {
  const repo = repository();
  const epic = await repo.createEpic({ projectId, title: key, rawRequest: key, position: 1 });
  const [ticket] = await repo.createTickets([
    {
      epicId: epic.id,
      key,
      title: key,
      description: key,
      acceptanceCriteria: [],
      fileScope: ["src"],
      size: "S",
      position: 1,
      dependsOnKeys: [],
    },
  ]);
  return ticket!;
}

/** The demo board, and Alice's board on the same repository. */
async function twoBoards() {
  const repo = repository();
  const ours = await repo.defaultProject();
  const alice = await repo.upsertUser({ githubId: 7, login: "alice", name: null, avatarUrl: null });
  const hers = await repo.ensureProject({ ownerId: alice.id, repoFullName: ours.repoFullName.toUpperCase(), baseBranch: "main" });
  return { ours, hers };
}

describe("notes agents share on a repository", () => {
  it("reach the agents on every board on the repository, but not the one that wrote them", async () => {
    const { ours, hers } = await twoBoards();
    const mine = await ticketOn(ours.id, "OUR-1");
    const theirs = await ticketOn(hers.id, "HER-1");

    await shareNote(hers.id, theirs.id, "  Renamed formatDate to formatDay.  ");

    expect((await sharedNotesFor(ours.id, mine.id)).map(sharedNoteLine)).toEqual([
      expect.stringMatching(/^\[note \d+\] HER-1: Renamed formatDate to formatDay\.$/),
    ]);
    expect(await sharedNotesFor(hers.id, theirs.id)).toEqual([]);
  });

  it("leaves out what was shared before the time asked from", async () => {
    const { ours } = await twoBoards();
    const mine = await ticketOn(ours.id, "OUR-1");
    const other = await ticketOn(ours.id, "OUR-2");

    await shareNote(ours.id, other.id, "Old news.");
    const since = new Date(Date.now() + 1_000);

    expect(await sharedNotes(ours.repoFullName, { exceptTicketId: mine.id, since })).toEqual([]);
  });

  it("keeps a note to its length", async () => {
    const { ours } = await twoBoards();
    const mine = await ticketOn(ours.id, "OUR-1");
    const other = await ticketOn(ours.id, "OUR-2");

    await shareNote(ours.id, other.id, "x".repeat(5_000));

    const [note] = await sharedNotesFor(ours.id, mine.id);
    expect(note!.text).toHaveLength(1_000);
  });

  it("drops a note an agent found outdated from briefings", async () => {
    const { ours } = await twoBoards();
    const mine = await ticketOn(ours.id, "OUR-1");
    const other = await ticketOn(ours.id, "OUR-2");
    const third = await ticketOn(ours.id, "OUR-3");

    await shareNote(ours.id, other.id, "Stale.");
    await shareNote(ours.id, other.id, "Still true.");
    const [stale] = await sharedNotesFor(ours.id, mine.id);
    await rateNote(ours.id, third.id, stale!.seq, "outdated");

    expect((await sharedNotesFor(ours.id, mine.id)).map((n) => n.text)).toEqual(["Still true."]);
  });

  it("keeps a note that helped past the day an unrated one fades in", async () => {
    const { ours } = await twoBoards();
    const mine = await ticketOn(ours.id, "OUR-1");
    const other = await ticketOn(ours.id, "OUR-2");
    const third = await ticketOn(ours.id, "OUR-3");

    await shareNote(ours.id, other.id, "Useful.");
    await shareNote(ours.id, other.id, "Never rated.");
    const [useful] = await sharedNotesFor(ours.id, mine.id);
    await rateNote(ours.id, third.id, useful!.seq, "helped");

    const inFiveDays = Date.now() + 5 * 24 * 60 * 60 * 1000;
    const later = await sharedNotes(ours.repoFullName, { exceptTicketId: mine.id, now: inFiveDays });
    expect(later.map((n) => n.text)).toEqual(["Useful."]);
  });
});
