import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const board = vi.hoisted(() => ({ current: { repoFullName: "me/app" } as { repoFullName: string } | null }));
vi.mock("@/lib/board/project", () => ({ activeProject: async () => board.current }));
const creds = vi.hoisted(() => ({ repoToken: "ghtok" as string | null }));
vi.mock("@/lib/auth/credentials", () => ({ credentialsFor: async () => creds }));

import type { UserRecord } from "@/lib/db/repository";
import { MockVcsClient, resetVcs, setVcs } from "@/lib/vcs";
import type { VcsClient } from "@/lib/vcs";
import { saveTokenToRepo } from "./agent-secret";

/** A Claude Code token pasted once reaches the repository secret its CI jobs sign in with. */

const me = { id: "u1" } as UserRecord;
const claude = { id: "p1", provider: "claude-code" as const, secretName: "FORMIC_CLAUDE_CODE_TOKEN" };

beforeEach(() => {
  MockVcsClient.reset();
  resetVcs();
  setVcs(new MockVcsClient("me/app"));
  board.current = { repoFullName: "me/app" };
  creds.repoToken = "ghtok";
});

describe("saveTokenToRepo", () => {
  it("writes the token into the board's repository under the agent's secret name", async () => {
    expect(await saveTokenToRepo(me, claude, "sk-ant-oat01-mine")).toEqual({ saved: true, name: "FORMIC_CLAUDE_CODE_TOKEN", repo: "me/app" });
    expect(MockVcsClient.secret("FORMIC_CLAUDE_CODE_TOKEN")).toBe("sk-ant-oat01-mine");
  });

  it("uses the name an older agent had, before names could be chosen", async () => {
    await saveTokenToRepo(me, { ...claude, secretName: null }, "t");
    expect(MockVcsClient.secret("FORMIC_CLAUDE_CODE_TOKEN_P1")).toBe("t");
  });

  it("does nothing for an agent that is not Claude Code", async () => {
    expect(await saveTokenToRepo(me, { id: "p2", provider: "anthropic", secretName: null }, "sk-ant-api")).toBeNull();
  });

  it("says why when it cannot: no repository, no access, or the host refused", async () => {
    board.current = null;
    expect(await saveTokenToRepo(me, claude, "t")).toMatchObject({ saved: false, reason: "this board has no repository" });

    board.current = { repoFullName: "me/app" };
    creds.repoToken = null;
    expect(await saveTokenToRepo(me, claude, "t")).toMatchObject({ saved: false, repo: "me/app", reason: expect.stringContaining("not connected") });

    creds.repoToken = "ghtok";
    setVcs({ name: "github", saveAgentSecret: async () => Promise.reject(new Error("GitHub said no (403)")) } as unknown as VcsClient);
    expect(await saveTokenToRepo(me, claude, "t")).toEqual({ saved: false, name: "FORMIC_CLAUDE_CODE_TOKEN", repo: "me/app", reason: "GitHub said no (403)" });
  });
});
