import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The report route is open to the internet: it must refuse anything without
 * the job's token, refuse a malformed report, and hand a good one to the
 * runner untouched. The runner's own behaviour is tested in runner.test.ts.
 */

const mocks = vi.hoisted(() => ({
  reportAllowed: vi.fn((job: string, since: string, token: string) => token === "good"),
  receiveReport: vi.fn(async () => ({ ok: true, stop: false })),
}));

vi.mock("@/lib/runner/runner", () => mocks);

const { POST } = await import("./route");

const BASE = "a".repeat(40);

function report(query: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/runner/report?${query}`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.reportAllowed.mockClear();
  mocks.receiveReport.mockClear();
});

describe("POST /api/runner/report", () => {
  it("refuses a report without the job's token, before reading it", async () => {
    const res = await POST(report("job=j1&since=5&token=bad", { lines: ["hi"] }));

    expect(res.status).toBe(403);
    expect(mocks.reportAllowed).toHaveBeenCalledWith("j1", "5", "bad");
    expect(mocks.receiveReport).not.toHaveBeenCalled();
  });

  it("refuses a report that names no job", async () => {
    const res = await POST(report("since=5&token=good", { lines: [] }));

    expect(res.status).toBe(403);
    expect(mocks.reportAllowed).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON, or not a report", async () => {
    expect((await POST(report("job=j1&since=5&token=good", "not json"))).status).toBe(400);
    expect((await POST(report("job=j1&since=5&token=good", { lines: "one" }))).status).toBe(400);
    expect(
      (
        await POST(
          report("job=j1&since=5&token=good", {
            checkpoint: { base: "not-a-sha", files: [], deleted: [] },
          }),
        )
      ).status,
    ).toBe(400);
    expect(mocks.receiveReport).not.toHaveBeenCalled();
  });

  it("hands a good report to the runner with its defaults filled, and returns the reply", async () => {
    const res = await POST(
      report("job=j1&since=5&token=good", {
        lines: ["one", "two"],
        checkpoint: {
          base: BASE,
          files: [{ path: "a.ts", mode: "100644", content: "x" }],
          deleted: ["b.ts"],
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, stop: false });
    expect(mocks.receiveReport).toHaveBeenCalledWith({
      job: "j1",
      since: 5,
      lines: ["one", "two"],
      after: 0,
      checkpoint: {
        base: BASE,
        files: [{ path: "a.ts", mode: "100644", content: "x" }],
        deleted: ["b.ts"],
        note: "",
      },
    });
  });
});
