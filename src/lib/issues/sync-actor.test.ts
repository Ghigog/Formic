import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { actingUserId, withActor } from "@/lib/auth/actor";
import { repository } from "@/lib/db";
import { resetMemoryStore } from "@/lib/db/memory-repository";
import { MockVcsClient, resetVcs, setVcs } from "@/lib/vcs";

const seen: Array<string | null> = [];

vi.mock("@/lib/auth/credentials", () => ({
  credentialsForProject: async () => {
    seen.push(actingUserId());
    return { githubToken: null, githubTokenKind: null, e2bKey: null, e2bFallbackUserId: null };
  },
}));

const { syncIssues } = await import("./sync");

/**
 * Issue comments go out on the board owner's token, even when the event is
 * published from inside a member's work.
 */
describe("issue sync actor", () => {
  beforeEach(() => {
    resetMemoryStore();
    setVcs(new MockVcsClient("acme/widgets"));
    seen.length = 0;
  });
  afterEach(() => resetVcs());

  it("runs as the owner when a member is acting", async () => {
    const epic = await repository().createEpic({ projectId: "project_default", title: "E", rawRequest: "E", position: 1 });
    await withActor("member_1", () =>
      syncIssues("project_default", { type: "card.created", cardId: epic.id, kind: "epic", epicId: null }),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((id) => id === null)).toBe(true);
  });
});
