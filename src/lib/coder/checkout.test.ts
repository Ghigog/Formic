import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openCheckout, pullRequestTitle, type CheckoutRequest } from "./checkout";
import { repository } from "@/lib/db";
import type { TicketDetail } from "@/lib/db/repository";
import { FALLBACK_CAP_MESSAGE } from "@/lib/sandbox/fallback-cap";

const spawnSandbox = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sandbox", () => ({ spawnSandbox }));

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  spawnSandbox.mockReset();
  spawnSandbox.mockResolvedValue({ id: "sbx", dispose: async () => {} });
  vi.stubEnv("SANDBOX_PROVIDER", "e2b");
  vi.stubEnv("E2B_FALLBACK_MINUTES_PER_USER", "1");
});

afterEach(() => vi.unstubAllEnvs());

async function request(fallback: boolean): Promise<CheckoutRequest> {
  const user = await repository().upsertUser({ githubId: 1, login: "octo", name: null, avatarUrl: null });
  return {
    projectId: "p",
    repoFullName: "o/r",
    fromBranch: "main",
    newBranch: null,
    ticket: { fileScope: [] },
    ctx: { signal: undefined, emit() {}, runId: "r" },
    githubToken: "t",
    e2bKey: "k",
    e2bFallbackUserId: fallback ? user.id : null,
  } as unknown as CheckoutRequest;
}

describe("the operator's fallback E2B key", () => {
  it("refuses a new sandbox once the person has used their minutes", async () => {
    const req = await request(true);
    await repository().addFallbackSandboxSeconds(req.e2bFallbackUserId!, 60, new Date().toISOString().slice(0, 7));
    await expect(openCheckout(req)).rejects.toThrow(FALLBACK_CAP_MESSAGE);
    expect(spawnSandbox).not.toHaveBeenCalled();
  });

  it("counts the time a sandbox ran against the person", async () => {
    const req = await request(true);
    vi.useFakeTimers({ toFake: ["Date"] });
    const checkout = await openCheckout(req);
    vi.advanceTimersByTime(90_000);
    await checkout.dispose();
    await checkout.dispose();
    vi.useRealTimers();
    const user = await repository().userById(req.e2bFallbackUserId!);
    expect(user?.fallbackSandboxSeconds).toBe(90);
  });

  it("does not cap a person on their own key", async () => {
    const req = await request(false);
    await expect(openCheckout(req)).resolves.toBeDefined();
  });
});

describe("the pull request title", () => {
  const ticket = (over: Partial<TicketDetail> = {}) =>
    ({
      key: "T-1",
      title: "Write the operating manual",
      issueNumber: 38,
      ...over,
    }) as TicketDetail;

  it("leads with the ticket key and the agent's one-line summary", () => {
    expect(pullRequestTitle(ticket(), { summary: "Wrote AGENTS.md" })).toBe("T-1: Wrote AGENTS.md");
  });

  it("keeps only the first line, whatever else the agent sent", () => {
    expect(
      pullRequestTitle(ticket(), { summary: "Wrote AGENTS.md\n\nAnd reduced CLAUDE.md." }),
    ).toBe("T-1: Wrote AGENTS.md");
  });

  it("drops a key the agent echoed and the issue it signed off with", () => {
    expect(pullRequestTitle(ticket(), { summary: "T-1: Wrote AGENTS.md" })).toBe(
      "T-1: Wrote AGENTS.md",
    );
    expect(pullRequestTitle(ticket(), { summary: "Wrote AGENTS.md - #38" })).toBe(
      "T-1: Wrote AGENTS.md",
    );
    expect(pullRequestTitle(ticket(), { summary: "Wrote AGENTS.md (#38)" })).toBe(
      "T-1: Wrote AGENTS.md",
    );
  });

  it("caps a paragraph to a title someone can scan", () => {
    const long = `Wrote AGENTS.md ${"and kept going ".repeat(20)}done.`;
    const title = pullRequestTitle(ticket(), { summary: long });
    expect(title).toMatch(/^T-1: Wrote AGENTS\.md /);
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual("T-1: ".length + 72);
  });

  it("falls back to the ticket's title when the agent sent nothing usable", () => {
    expect(pullRequestTitle(ticket(), { summary: "  \n" })).toBe("T-1: Write the operating manual");
  });
});
