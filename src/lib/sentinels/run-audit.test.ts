import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
vi.mock("@/lib/agents/anthropic", () => ({
  anthropicClient: () => ({ beta: { messages: { create } } }),
  describeError: String,
  usageFrom: (model: string) => ({ model, tokensIn: 1, tokensOut: 1, costCents: 1 }),
}));

const { cut, runAudit } = await import("./agent");
const { sentinel } = await import("./roster");

const file = Array.from({ length: 10 }, (_, i) => (i === 6 ? "export function late() {" : `line ${i + 1}`)).join("\n");

describe("cut", () => {
  it("shows a file whole when it fits", () => {
    expect(cut("a.ts", file, 0, null, 10_000)).toMatchObject({ note: "10 lines", outline: [] });
  });

  it("cuts on a line break and outlines what it left out", () => {
    const r = cut("a.ts", file, 0, null, 30);
    expect(r.note).toBe("lines 1-4 of 10");
    expect(r.text).toBe("line 1\nline 2\nline 3\nline 4\n… (cut at line 4; ask for more by line range)");
    expect(r.outline).toEqual(["7: export function late() {"]);
  });

  it("shows what fits of a line longer than the share", () => {
    const r = cut("min.js", "x".repeat(100), 0, null, 10);
    expect(r.text.startsWith("xxxxxxxxxx\n…")).toBe(true);
  });

  it("reads a range it was asked for", () => {
    const r = cut("a.ts", file, 7, 9, 10_000);
    expect(r.note).toBe("lines 8-9 of 10");
    expect(r.text.startsWith("line 8\nline 9\n")).toBe(true);
  });
});

const answer = (value: unknown) => ({
  stop_reason: "end_turn",
  usage: {},
  content: [{ type: "text", text: JSON.stringify(value) }],
});

const report = {
  stars: 4,
  quote: "Tested, mostly.",
  summary: "Good. One gap.",
  likes: [],
  dislikes: [],
  wrong: [],
  missing: [{ text: "No tests for github.ts.", ref: "src/lib/vcs/github.ts" }],
};

describe("runAudit", () => {
  beforeEach(() => create.mockReset());

  it("picks, follows up, then scores with the facts and screenshots attached", async () => {
    create
      .mockResolvedValueOnce(answer({ paths: ["src/a.ts"] }))
      .mockResolvedValueOnce(
        answer({
          more: [
            { path: "src/b.ts", from: null, to: null },
            { path: "nope.ts", from: 1, to: 2 },
            { path: "src/a.ts", from: 1, to: 1 },
          ],
        }),
      )
      .mockResolvedValueOnce(answer(report));
    const read = vi.fn(async (path: string) => (path === "src/a.ts" ? 'import { b } from "./b";' : path === "src/b.ts" ? "export const b = 1;" : null));
    const log = vi.fn(async (_step: string) => {});

    const out = await runAudit(
      { model: "claude-sonnet-5" } as never,
      {
        sentinel: sentinel("tester")!,
        repoFullName: "o/r",
        files: ["src/a.ts", "src/b.ts"],
        read,
        evidence: { sections: ["CI on main: all green."], images: [{ name: "s/board.png", mediaType: "image/png", data: Buffer.from([1, 2]) }] },
        log,
        signal: new AbortController().signal,
      },
    );

    expect(out).toMatchObject({ ok: true, stars: 4, files: ["src/a.ts", "src/b.ts"] });
    expect(create).toHaveBeenCalledTimes(3);
    expect(log.mock.calls.map(([step]) => step)).toEqual([
      "Choosing what a Tester reads",
      "Reading 1 files",
      "Reading more",
      "Scoring as Tester",
      "Writing report",
    ]);

    // The follow-up is asked from paths, not the code again; and a path not
    // in the repository is never read.
    const follow = create.mock.calls[1]![0];
    expect(follow.messages[0].content.at(-1).text).toContain("- src/a.ts (1 lines)");
    expect(read).not.toHaveBeenCalledWith("nope.ts");
    // Nor is a file it already has whole read again.
    expect(read.mock.calls.filter(([p]) => p === "src/a.ts")).toHaveLength(1);

    const scoring = create.mock.calls[2]![0];
    expect(scoring.system).toContain("You cannot run anything");
    const [image, text] = scoring.messages[0].content;
    expect(image).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "AQI=" } });
    expect(text.text).toContain("Facts gathered for your role:\nCI on main: all green.");
    expect(text.text).toContain("=== src/b.ts (1 lines) ===\nexport const b = 1;");
  });
});
