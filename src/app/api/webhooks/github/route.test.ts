import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The webhook receiver's own contract: nothing unsigned is trusted, nothing is
 * handled twice, and an issue a person labelled for intake reaches the same
 * import the sweep uses. The route had no test before this.
 */

const mocks = vi.hoisted(() => ({
  launched: [] as Array<{ label: string; work: () => Promise<void> }>,
  importIssues: vi.fn(async () => undefined),
}));

vi.mock("@/lib/agents/pipeline", () => ({
  launch: (work: () => Promise<void>, label: string) => mocks.launched.push({ label, work }),
}));
vi.mock("@/lib/issues/intake", () => ({ importIssues: mocks.importIssues }));
vi.mock("@/lib/review/pipeline", () => ({
  markMergedExternally: vi.fn(),
  reviewPullRequest: vi.fn(),
}));
vi.mock("@/lib/runner/runner", () => ({ completeCliRun: vi.fn() }));
vi.mock("@/lib/events/bus", () => ({ publish: vi.fn() }));

const { POST } = await import("./route");
const { resetEnvCache } = await import("@/lib/secrets/env");

const SECRET = "shhh";
/** The demo board's repository, which is the one the memory store knows. */
const REPO = "Ghigog/Formic";
const LABELLED = { number: 42, labels: [{ name: "formic: intake" }] };

function delivery(event: string, body: unknown, signature = true): NextRequest {
  const raw = JSON.stringify(body);
  const hmac = createHmac("sha256", SECRET).update(raw, "utf8").digest("hex");
  return new NextRequest("http://localhost/api/webhooks/github", {
    method: "POST",
    body: raw,
    headers: {
      "x-github-event": event,
      "x-hub-signature-256": signature ? `sha256=${hmac}` : "sha256=nope",
    },
  });
}

beforeEach(() => {
  mocks.launched.length = 0;
  mocks.importIssues.mockClear();
  (globalThis as { __formicMemoryStore?: unknown }).__formicMemoryStore = undefined;
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", SECRET);
  resetEnvCache();
});

describe("POST /api/webhooks/github", () => {
  it("refuses a delivery it cannot prove came from GitHub", async () => {
    const res = await POST(delivery("issues", { action: "labeled", issue: LABELLED }, false));

    expect(res.status).toBe(401);
    expect(mocks.launched).toEqual([]);
  });

  it("ignores an issue it has no opinion about, without handling anything", async () => {
    const res = await POST(
      delivery("issues", {
        action: "opened",
        issue: { number: 7, labels: [{ name: "bug" }] },
        repository: { full_name: REPO },
      }),
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, handled: 0, ignored: true });
    expect(mocks.launched).toEqual([]);
  });

  it("launches the same import the sweep uses for a labelled issue", async () => {
    const res = await POST(
      delivery("issues", { action: "labeled", issue: LABELLED, repository: { full_name: REPO } }),
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, handled: 1, received: 1 });

    for (const l of mocks.launched) await l.work();
    expect(mocks.importIssues).toHaveBeenCalledWith("project_default", 42);
  });

  it("answers a redelivery of the same issue without importing again", async () => {
    await POST(
      delivery("issues", { action: "labeled", issue: LABELLED, repository: { full_name: REPO } }),
    );
    // The same issue, delivered again under a new id: the key is the issue.
    const again = await POST(
      delivery("issues", { action: "reopened", issue: LABELLED, repository: { full_name: REPO } }),
    );

    expect(await again.json()).toEqual({ ok: true, handled: 0, received: 1 });
  });
});
