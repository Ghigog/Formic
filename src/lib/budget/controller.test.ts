import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("DATABASE_URL", "");
vi.stubEnv("POSTGRES_PRISMA_URL", "");
vi.stubEnv("POSTGRES_URL", "");

const { repository } = await import("@/lib/db");
const { beginRun, endRun, recordSpend, spendFor, stopAll } = await import("./controller");

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  globalThis.__formicRuns = undefined;
});

/** What pipeline.ts's own startRun does: register locally and journal to the database. */
async function openRun(input: { runId: string; projectId: string; epicId?: string | null; ticketId?: string | null }) {
  const signal = beginRun(input);
  await repository().startRun({
    id: input.runId,
    role: "coder",
    epicId: input.epicId ?? null,
    ticketId: input.ticketId ?? null,
    model: null,
    sandboxId: null,
  });
  return signal;
}

describe("stopAll", () => {
  it("writes a durable flag a run on another instance can poll for", async () => {
    const project = await repository().defaultProject();
    expect(await repository().stopRequestedAt(project.id)).toBeNull();

    await stopAll(project.id);

    expect(await repository().stopRequestedAt(project.id)).toBeInstanceOf(Date);
  });

  it("counts every run the database has going for the project, not only this process's own registry", async () => {
    const project = await repository().defaultProject();
    const epic = await repository().createEpic({
      projectId: project.id,
      title: "e",
      rawRequest: "e",
      position: 1,
    });
    await openRun({ runId: "run-1", projectId: project.id, epicId: epic.id });

    expect(await stopAll(project.id)).toBe(1);
  });

  it("leaves another project's runs alone", async () => {
    const home = await repository().defaultProject();
    const other = await repository().ensureProject({
      ownerId: "u1",
      repoFullName: "acme/widgets",
      baseBranch: "main",
    });
    const epic = await repository().createEpic({
      projectId: other.id,
      title: "e",
      rawRequest: "e",
      position: 1,
    });
    await openRun({ runId: "run-1", projectId: other.id, epicId: epic.id });

    expect(await stopAll(home.id)).toBe(0);
    expect(await repository().stopRequestedAt(other.id)).toBeNull();
  });
});

describe("recordSpend and the Epic budget", () => {
  it("keeps a finished run's spend counted toward its Epic after the run ends", async () => {
    const project = await repository().defaultProject();
    const epic = await repository().createEpic({
      projectId: project.id,
      title: "e",
      rawRequest: "e",
      position: 1,
    });

    // Ten runs at 185 cents each: 1,850 of the Epic's 2,000-cent ceiling,
    // each safely under a single run's own 200-cent cap, and each settled
    // before the next begins so only the database remembers them.
    for (let i = 0; i < 10; i++) {
      await openRun({ runId: `spent-${i}`, projectId: project.id, epicId: epic.id });
      await recordSpend(`spent-${i}`, { cents: 185 });
      endRun(`spent-${i}`);
    }

    await openRun({ runId: "new-run", projectId: project.id, epicId: epic.id });
    const ok = await recordSpend("new-run", { cents: 199 });

    expect(ok).toBe(false);
    // Stopped: the budget controller aborted and dropped it.
    expect(spendFor("new-run")).toBeNull();

    const events = await repository().eventsAfter(project.id, 0);
    const exhausted = events.find((e) => e.type === "budget.exhausted") as
      | { payload: { scope: string; detail: string } }
      | undefined;
    expect(exhausted?.payload.scope).toBe("epic");
    expect(exhausted?.payload.detail).toMatch(/Epic budget/);
  });

  it("does not stop a run for its Epic's spend while it is still under the ceiling", async () => {
    const project = await repository().defaultProject();
    const epic = await repository().createEpic({
      projectId: project.id,
      title: "e",
      rawRequest: "e",
      position: 1,
    });
    await openRun({ runId: "run-1", projectId: project.id, epicId: epic.id });

    const ok = await recordSpend("run-1", { cents: 50 });

    expect(ok).toBe(true);
    expect(spendFor("run-1")?.cents).toBe(50);
  });
});
