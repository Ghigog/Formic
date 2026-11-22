import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRecord } from "@/lib/db/repository";
import type { VcsClient } from "@/lib/vcs";
import { BranchMovedError } from "@/lib/vcs/types";

/*
 * Where the PM's change lands, enforced on the server whatever the session
 * was told (docs/plans/pm-chat.md, safety rows 1 and 4).
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/credentials", () => ({ credentialsForProject: async () => ({ repoToken: "t" }) }));
vi.mock("@/lib/events/bus", () => ({ publish: vi.fn(async () => undefined) }));
vi.mock("@/lib/fixtures/board", () => ({ FIXTURE_CARDS: [], FIXTURE_TICKET_DETAILS: {} }));

const { repository } = await import("@/lib/db");
const { createEpic } = await import("@/lib/mcp/tools");
const { landPmChange, ownBranch } = await import("./land");
const { lockBranch, runHolder } = await import("@/lib/runner/branch-lock");
const { setVcs, resetVcs } = await import("@/lib/vcs");

let n = 1;
let me: UserRecord;
let board: string;

function fakeGitHub(over: Partial<Record<keyof VcsClient, unknown>> = {}) {
  const heads = new Map([["formic/t1", "aaa"]]);
  const client = {
    name: "github",
    branchHead: vi.fn(async (b: string) => heads.get(b) ?? null),
    compare: vi.fn(async () => ({ files: ["src/a.ts"], messages: ["Fix the login form"], headSha: "bbb" })),
    moveBranch: vi.fn(async (b: string, sha: string) => void heads.set(b, sha)),
    findPullRequest: vi.fn(async () => null),
    openPullRequest: vi.fn(async (input: { headBranch: string }) => ({ number: 9, url: "https://github.com/me/app/pull/9", headBranch: input.headBranch })),
    ...over,
  };
  setVcs(client as unknown as VcsClient);
  return client;
}

async function ticket(status: "review" | "running" = "review") {
  const made = await createEpic(
    { user: me, readOnly: false },
    { board, title: "E", rawRequest: "req", tickets: [{ key: "a", title: "Login form", description: "d", acceptanceCriteria: ["c"] }] },
  );
  if (!made.ok) throw new Error(made.error);
  const t = made.value.tickets[0]!;
  await repository().updateTicket(t.id, { prNumber: 7, branchName: "formic/t1" });
  await repository().move({ cardId: t.id, kind: "ticket", status, stalledIn: null, position: 1 });
  return t;
}

const notices = async () => (await repository().assistantMessages(board)).messages.filter((m) => m.kind === "notice").map((m) => m.content);
const land = (wanted: string | null, client: ReturnType<typeof fakeGitHub>) =>
  landPmChange({ projectId: board, job: "msg1--abcd1234", sha: "bbb", wanted, client: client as unknown as VcsClient });

beforeEach(async () => {
  globalThis.__formicMemoryStore = undefined;
  for (const v of ["DATABASE_URL", "POSTGRES_PRISMA_URL", "POSTGRES_URL"]) delete process.env[v];
  const repo = repository();
  me = await repo.upsertUser({ githubId: n++, login: `pm${n}`, name: null, avatarUrl: null });
  board = (await repo.ensureProject({ ownerId: me.id, repoFullName: "me/app", name: "My App", baseBranch: "main" })).id;
  resetVcs();
});

describe("landing the PM's change", () => {
  it("fast-forwards a ticket's branch nobody is working on, and says so", async () => {
    const t = await ticket();
    const client = fakeGitHub();
    const landed = await land("formic/t1", client);
    expect(landed?.branch).toBe("formic/t1");
    expect(client.moveBranch).toHaveBeenCalledWith("formic/t1", "bbb");
    expect(client.openPullRequest).not.toHaveBeenCalled();
    expect(await notices()).toEqual([`The PM pushed 1 commit to ${t.key}'s branch formic/t1.`]);
  });

  it("never pushes under an agent run: the change goes to the PM's own branch instead", async () => {
    await ticket("running");
    const client = fakeGitHub();
    const landed = await land("formic/t1", client);
    expect(landed?.branch).toBe(ownBranch("My App", "msg1--abcd1234"));
    expect(client.moveBranch).toHaveBeenCalledWith("formic-pm/my-app-abcd1234", "bbb");
    expect((await notices())[0]).toContain("agent is working on formic/t1");

    // Nor while a run holds the branch lock, even if the card says otherwise.
    globalThis.__formicMemoryStore = undefined;
    me = await repository().upsertUser({ githubId: n++, login: `pm${n}`, name: null, avatarUrl: null });
    board = (await repository().ensureProject({ ownerId: me.id, repoFullName: "me/app", name: "My App", baseBranch: "main" })).id;
    await ticket();
    await lockBranch(board, "formic/t1", runHolder("job-9"), 60_000);
    const again = fakeGitHub();
    expect((await land("formic/t1", again))?.branch).toBe("formic-pm/my-app-abcd1234");
  });

  it("never rewrites a branch that moved on: the change keeps its own branch", async () => {
    await ticket();
    const client = fakeGitHub({
      moveBranch: vi.fn(async (b: string) => {
        if (b === "formic/t1") throw new BranchMovedError(b, "ccc");
      }),
    });
    expect((await land("formic/t1", client))?.branch).toBe("formic-pm/my-app-abcd1234");
    expect((await notices())[0]).toContain("never rewrites a branch");
  });

  it("puts work on the base branch, a stranger's branch or no branch on its own, with a pull request", async () => {
    for (const wanted of ["main", "someone/else", "HEAD", null]) {
      globalThis.__formicMemoryStore = undefined;
      me = await repository().upsertUser({ githubId: n++, login: `pm${n}`, name: null, avatarUrl: null });
      board = (await repository().ensureProject({ ownerId: me.id, repoFullName: "me/app", name: "My App", baseBranch: "main" })).id;
      const client = fakeGitHub();
      const landed = await land(wanted, client);
      expect(landed?.branch, String(wanted)).toBe("formic-pm/my-app-abcd1234");
      expect(client.moveBranch).not.toHaveBeenCalledWith("main", expect.anything());
      expect(client.openPullRequest).toHaveBeenCalledWith(expect.objectContaining({ headBranch: "formic-pm/my-app-abcd1234", title: "Fix the login form" }));
      expect((await notices()).at(-1)).toContain("Opened pull request #9");
    }
  });

  it("refuses a change to the workflows outright", async () => {
    const client = fakeGitHub({ compare: vi.fn(async () => ({ files: [".github/workflows/ci.yml"], messages: ["x"], headSha: "bbb" })) });
    expect(await land("formic-pm/x", client)).toBeNull();
    expect(client.moveBranch).not.toHaveBeenCalled();
    expect(await notices()).toEqual([expect.stringContaining(".github/workflows/")]);
  });
});
