import { describe, expect, it, vi } from "vitest";

vi.stubEnv("DATABASE_URL", "");
vi.stubEnv("POSTGRES_PRISMA_URL", "");
vi.stubEnv("POSTGRES_URL", "");

const { repository } = await import("@/lib/db");
const { ORPHAN_AFTER_MS, reconcileOrphanedRuns } = await import("./recovery");

describe("reconcileOrphanedRuns", () => {
  it("leaves a run that could still be live in another instance alone", async () => {
    await repository().startRun({
      id: "run_live",
      role: "product",
      epicId: null,
      ticketId: null,
      model: "mock",
      sandboxId: null,
    });

    expect(await reconcileOrphanedRuns(new Date())).toBe(0);
    expect(
      await reconcileOrphanedRuns(new Date(Date.now() + ORPHAN_AFTER_MS + 1_000)),
    ).toBe(1);
  });
});
