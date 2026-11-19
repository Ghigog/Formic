import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSummary, UserRecord } from "@/lib/db/repository";
import type { BoardCard } from "@/lib/domain/entities";

const m = vi.hoisted(() => ({
  cards: [] as BoardCard[],
  level: 15,
  mode: "accounts" as "accounts" | "local",
  repoToken: "tok" as string | null,
}));

vi.mock("@/lib/db", () => ({ repository: () => ({ boardCards: async () => m.cards }) }));
vi.mock("@/lib/auth/session", () => ({ authMode: () => m.mode }));
vi.mock("@/lib/auth/credentials", () => ({ credentialsFor: async () => ({ repoToken: m.repoToken }) }));
vi.mock("@/lib/secrets/vault", () => ({ open: (s: string) => (s === "sealed" ? "e2b-own" : null) }));
vi.mock("@/lib/colony/game", async (orig) => ({
  ...(await orig<typeof import("@/lib/colony/game")>()),
  scoreOf: () => ({ level: m.level }),
}));

const { playtestAccess, ownE2bKey } = await import("./access");

const merged = { kind: "ticket", status: "merged", stalledIn: null, mergedAt: "2026-11-01T00:00:00Z" } as unknown as BoardCard;
const project = (over: Partial<ProjectSummary> = {}) =>
  ({ id: "p", repoFullName: "a/b", baseBranch: "main", unlockAllSentinels: false, ...over }) as ProjectSummary;
const user = (cipher: string | null = "sealed") => ({ id: "u", e2bKeyCipher: cipher }) as UserRecord;

beforeEach(() => {
  m.cards = [merged];
  m.level = 15;
  m.mode = "accounts";
  m.repoToken = "tok";
  delete process.env.E2B_API_KEY;
});

describe("playtestAccess", () => {
  it("lets a person with their own key and access play a board that has shipped", async () => {
    expect(await playtestAccess(project(), user())).toEqual({ ok: true, e2bKey: "e2b-own", repoToken: "tok" });
  });

  it("stays locked below its level, unless the board unlocks everything", async () => {
    m.level = 14;
    expect(await playtestAccess(project(), user())).toMatchObject({ ok: false, reason: "locked" });
    expect((await playtestAccess(project({ unlockAllSentinels: true }), user())).ok).toBe(true);
  });

  it("never uses the server's key for a signed-in person", async () => {
    process.env.E2B_API_KEY = "server-key";
    expect(await playtestAccess(project(), user(null))).toMatchObject({ ok: false, reason: "no-key" });
    expect(ownE2bKey(user(null))).toBeNull();
    m.mode = "local";
    expect(ownE2bKey(user(null))).toBe("server-key");
  });

  it("says why when there is no repository, nothing merged, or no access to it", async () => {
    expect(await playtestAccess(project({ repoFullName: "" }), user())).toMatchObject({ reason: "no-repo" });
    m.cards = [{ ...merged, mergedAt: null } as BoardCard];
    expect(await playtestAccess(project(), user())).toMatchObject({ reason: "nothing-merged" });
    m.cards = [merged];
    m.repoToken = null;
    expect(await playtestAccess(project(), user())).toMatchObject({ reason: "no-repo-access" });
  });
});
