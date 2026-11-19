import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository, resetMemoryStore } from "@/lib/db/memory-repository";
import type { ProjectSummary } from "@/lib/db/repository";
import { PlaytestError, type PlaytestRunner, type StartOptions } from "./runner";

const { launched, answer, branchHead } = vi.hoisted(() => ({
  launched: [] as Promise<void>[],
  answer: vi.fn(async () => {}),
  branchHead: vi.fn(async () => "sha-1"),
}));

vi.mock("@/lib/db", async () => {
  const { MemoryRepository } = await import("@/lib/db/memory-repository");
  const repo = new MemoryRepository();
  return { repository: () => repo, hasDatabase: () => false };
});
vi.mock("@/lib/agents/pipeline", () => ({ launch: (work: () => Promise<void>) => launched.push(work()) }));
vi.mock("@/lib/assistant/turn", () => ({ answer }));
vi.mock("@/lib/events/bus", () => ({ publish: async () => 1 }));
vi.mock("@/lib/auth/credentials", () => ({ credentialsFor: async () => ({ repoToken: "tok" }) }));
vi.mock("@/lib/vcs", () => ({ vcs: () => ({ branchHead }) }));
vi.mock("./access", () => ({ ownE2bKey: () => "e2b-key" }));

const service = await import("./service");
const { repository } = await import("@/lib/db");
const repo = repository() as MemoryRepository;

const project = { id: "p1", repoFullName: "acme/game", baseBranch: "main" } as ProjectSummary;
const kills: string[] = [];
let gate: { resolve: () => void } | null = null;
let seen: StartOptions | null = null;

const runner: PlaytestRunner = {
  async start(o) {
    seen = o;
    o.onSandbox("sb-1");
    o.onStage("clone");
    o.onLog("cloning");
    if (gate) await new Promise<void>((r) => (gate!.resolve = r));
    if (o.signal?.aborted) throw new Error("Stopped.");
    return { url: "https://8484-sb-1.e2b.app", commitSha: "sha-1", kind: "godot" };
  },
  async kill(id) {
    kills.push(id);
  },
};

async function settle() {
  await Promise.all(launched.splice(0));
}

async function start(userId = "u1") {
  const r = await service.startPlaytest({ project, userId, e2bKey: "e2b-key", repoToken: "tok", formicOrigin: "https://formic.test" });
  return r;
}

beforeEach(() => {
  resetMemoryStore();
  service.setPlaytestRunner(runner);
  kills.length = 0;
  gate = null;
  seen = null;
  answer.mockClear();
  branchHead.mockReset().mockResolvedValue("sha-1");
});

describe("playtest sessions", () => {
  it("starts a sandbox on the person's key, with a bare remote, and goes live", async () => {
    const r = await start();
    expect(r.status).toBe("starting");
    await settle();
    expect(seen).toMatchObject({
      apiKey: "e2b-key",
      cloneUrl: "https://x-access-token:tok@github.com/acme/game.git",
      bareUrl: "https://github.com/acme/game.git",
      branch: "main",
      formicOrigin: "https://formic.test",
    });
    const now = (await repo.playtest(r.id))!;
    expect(now).toMatchObject({ status: "live", url: "https://8484-sb-1.e2b.app", commitSha: "sha-1", sandboxId: "sb-1", kind: "godot" });
    expect(service.viewOf(now).url).toBe("https://8484-sb-1.e2b.app");
  });

  it("records a failure with its reason and kills the sandbox", async () => {
    service.setPlaytestRunner({
      ...runner,
      async start(o) {
        o.onSandbox("sb-2");
        throw new PlaytestError("Playtest runs web apps and Godot games for now.", "project");
      },
    });
    const r = await start();
    await settle();
    expect(await repo.playtest(r.id)).toMatchObject({ status: "failed", endReason: "failed", error: "Playtest runs web apps and Godot games for now." });
    expect(kills).toEqual(["sb-2"]);
  });

  it("marks Playtest's own failures apart from the project's, so no agent is offered for them", async () => {
    for (const thrown of [new PlaytestError("Fetching what Playtest needs to run it failed.", "playtest"), new Error("socket hang up")]) {
      service.setPlaytestRunner({
        ...runner,
        async start() {
          throw thrown;
        },
      });
      const r = await start();
      await settle();
      expect(await repo.playtest(r.id)).toMatchObject({ status: "failed", endReason: "unavailable" });
    }
  });

  it("keeps one session per person: starting another ends the first", async () => {
    const first = await start();
    await settle();
    const second = await start();
    await settle();
    expect(await repo.playtest(first.id)).toMatchObject({ status: "ended", endReason: "replaced" });
    expect((await repo.playtest(second.id))?.status).toBe("live");
    expect(kills).toEqual(["sb-1"]);
  });

  it("stops a session that is still starting, and never brings it live", async () => {
    gate = { resolve: () => {} };
    const r = await start();
    await vi.waitFor(async () => expect((await repo.playtest(r.id))?.sandboxId).toBe("sb-1"));
    await service.stopPlaytest(r.id, "stopped");
    gate.resolve();
    await settle();
    expect(await repo.playtest(r.id)).toMatchObject({ status: "ended", endReason: "stopped", url: null });
    expect(kills).toContain("sb-1");
  });

  it("warns at five minutes, says when newer work merged, and ends on time", async () => {
    const r = await start();
    await settle();
    let rec = (await repo.playtest(r.id))!;
    await repo.updatePlaytest(r.id, { endsAt: new Date(Date.now() + 4 * 60_000) });
    branchHead.mockResolvedValue("sha-2");
    rec = await service.tick((await repo.playtest(r.id))!, project);
    expect(rec.warned).toBe(true);
    expect(rec.nudgedSha).toBe("sha-2");
    expect(service.viewOf(rec).newer).toBe(true);
    const lines = (await repo.playtestMessages(r.id)).map((m) => m.content);
    expect(lines).toEqual(["5 minutes left in this playtest.", "Newer work just landed on the default branch. Restart to play it."]);

    await repo.updatePlaytest(r.id, { endsAt: new Date(Date.now() - 1) });
    rec = await service.tick((await repo.playtest(r.id))!, project);
    expect(rec).toMatchObject({ status: "ended", endReason: "time" });
  });

  it("asks the PM once about every note since it last asked, and sums the session up at the end", async () => {
    const r = await start();
    await settle();
    let rec = (await repo.playtest(r.id))!;
    const shot = await repo.createAttachment({
      projectId: project.id,
      requestId: "playtest-x",
      filename: "shot.png",
      mimeType: "image/png",
      kind: "image",
      size: 1,
      bytes: new Uint8Array([1]),
    });
    // Another board's upload is never claimed, whatever id is sent.
    await repo.createAttachment({ projectId: "other", requestId: "playtest-y", filename: "x.png", mimeType: "image/png", kind: "image", size: 1, bytes: new Uint8Array([1]) });
    const note = await service.addNote(rec, "The jump feels late", ["playtest-x", "playtest-y", "not-a-playtest"]);
    expect(note.attachments.map((a) => a.id)).toEqual([shot.id]);
    await service.addNote(rec, "Score does not reset", []);
    expect(await service.askAboutNotes(rec)).toBe(true);
    await settle();
    expect(answer).toHaveBeenCalledTimes(1);
    rec = (await repo.playtest(r.id))!;
    expect(await service.askAboutNotes(rec)).toBe(false);

    const reply = (await repo.playtestMessages(r.id)).find((m) => m.role === "assistant")!;
    await repo.updateAssistantMessage(reply.id, {
      status: "done",
      content: "**Intended**: coyote time.\n\n**Worth a ticket**: the score.",
      proposals: [{ summary: "Fix score reset", action: { type: "create_backlog_item", request: "x" }, state: "proposed" }],
    });
    await service.stopPlaytest(r.id, "stopped");
    const ended = (await repo.playtest(r.id))!;
    expect(ended.summary).toBe("2 notes, 1 ticket proposed, 1 intended.");
    expect((await repo.playtestMessages(r.id)).at(-1)?.content).toBe("Playtest over. 2 notes, 1 ticket proposed, 1 intended.");
  });

  it("reaps a session whose screen stopped polling", async () => {
    const r = await start();
    await settle();
    await service.reap(Date.now() + service.STALE_MS + 1000);
    expect(await repo.playtest(r.id)).toMatchObject({ status: "ended", endReason: "closed" });
  });
});
