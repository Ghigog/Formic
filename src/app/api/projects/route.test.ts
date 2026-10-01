import { beforeEach, describe, expect, it, vi } from "vitest";

/** Stands in for Next's request scope; see src/lib/auth/isolation.test.ts. */
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

const { repository } = await import("@/lib/db");
const { currentUser } = await import("@/lib/auth/user");
const { GET } = await import("./route");

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
});

describe("GET /api/projects", () => {
  it("names each project's latest finished assistant message, or null", async () => {
    const repo = repository();
    const user = (await currentUser())!;
    const project = await repo.ensureProject({ ownerId: user.id, repoFullName: "acme/widgets", baseBranch: "main" });
    const done = await repo.addAssistantMessage({ projectId: project.id, role: "assistant", content: "hi", status: "done" });
    await repo.addAssistantMessage({ projectId: project.id, role: "assistant", content: "", status: "pending" });

    const body = (await (await GET()).json()) as {
      projects: Array<{ id: string; lastAssistantMessage: { id: string } | null }>;
    };
    expect(body.projects.find((p) => p.id === project.id)!.lastAssistantMessage?.id).toBe(done.id);
  });
});
