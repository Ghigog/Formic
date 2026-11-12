import { beforeEach, describe, expect, it } from "vitest";
import { makeCard } from "@/test/cards";

const { claimMergeSlot, releaseMergeSlot } = await import("./merge-lane");
const { repository } = await import("@/lib/db");
const { seedMemory } = await import("@/lib/db/memory-repository");

const PROJECT = "project_default";

function ticket(id: string, extra: Parameters<typeof makeCard>[0] = {}) {
  return makeCard({ id, status: "review", prNumber: Number(id.slice(1)), ...extra });
}

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_PRISMA_URL;
  delete process.env.POSTGRES_URL;
});

describe("the merge slot", () => {
  it("lets a move-only ticket take it before an earlier normal one", async () => {
    seedMemory([ticket("t5"), ticket("t6"), ticket("t7", { moveOnly: true })]);
    expect(await claimMergeSlot(PROJECT, "t5")).toBe(true);
    expect(await claimMergeSlot(PROJECT, "t6")).toBe(false);
    expect(await claimMergeSlot(PROJECT, "t7")).toBe(false);

    await releaseMergeSlot(PROJECT, "t5");

    expect(await claimMergeSlot(PROJECT, "t6")).toBe(false);
    expect(await claimMergeSlot(PROJECT, "t7")).toBe(true);
    expect(await claimMergeSlot(PROJECT, "t6")).toBe(false);
  });

  it("does not take the slot from the ticket holding it", async () => {
    seedMemory([ticket("t5"), ticket("t7", { moveOnly: true })]);
    await claimMergeSlot(PROJECT, "t5");
    await claimMergeSlot(PROJECT, "t7");
    expect(await claimMergeSlot(PROJECT, "t5")).toBe(true);
  });

  it("goes on without a move-only ticket that was sent back from review", async () => {
    seedMemory([ticket("t5"), ticket("t6"), ticket("t7", { moveOnly: true })]);
    await claimMergeSlot(PROJECT, "t5");
    await claimMergeSlot(PROJECT, "t7");
    await releaseMergeSlot(PROJECT, "t5");
    await repository().updateTicket("t7", { status: "ready" });

    expect(await claimMergeSlot(PROJECT, "t6")).toBe(true);
  });
});
