import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { repository, activeProject, launch, collectCliRuns, sweepOpenPullRequests, sweepIdleCards } =
  vi.hoisted(() => {
    const repo = { boardCards: vi.fn() };
    return {
      repository: () => repo,
      activeProject: vi.fn(),
      launch: vi.fn(),
      collectCliRuns: vi.fn(),
      sweepOpenPullRequests: vi.fn(),
      sweepIdleCards: vi.fn(),
    };
  });

vi.mock("@/lib/db", () => ({ repository }));
vi.mock("@/lib/board/project", () => ({ activeProject }));
vi.mock("@/lib/runner/runner", () => ({ collectCliRuns }));
vi.mock("@/lib/agents/pipeline", () => ({ launch }));
vi.mock("@/lib/review/pipeline", () => ({ sweepOpenPullRequests }));
vi.mock("@/lib/board/idle", () => ({ sweepIdleCards }));

const { GET } = await import("./route");
const { clearBuckets } = await import("@/lib/rate-limit");

const repo = () => repository() as { boardCards: ReturnType<typeof vi.fn> };

beforeEach(() => {
  clearBuckets();
  activeProject.mockResolvedValue({ id: "project_default" });
  repo().boardCards.mockResolvedValue([]);
});

function refresh(): Promise<Response> {
  return GET(new NextRequest("http://localhost/api/board"));
}

describe("GET /api/board", () => {
  it("lets three hundred refreshes from one address through in a minute and refuses the next", async () => {
    // A refresh starts the sweeps and the UI polls it, so the board has its
    // own generous bucket rather than the shared run-start one.
    for (let i = 0; i < 300; i++) expect((await refresh()).status).toBe(200);

    const res = await refresh();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/[Tt]oo many/) });
    expect(launch).toHaveBeenCalledTimes(300 * 3);
  });

  it("returns the board while the budget lasts", async () => {
    const res = await refresh();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ project: { id: "project_default" }, cards: [] });
    expect(launch).toHaveBeenCalledTimes(3);
  });
});
