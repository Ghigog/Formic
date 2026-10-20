import { describe, expect, it } from "vitest";
import {
  KEEP_RECENT_TURNS,
  MASK_BATCH_CHARS,
  type Observation,
  maskedNote,
  staleObservations,
  tidyOutput,
} from "./observations";

describe("tidyOutput", () => {
  it("strips colour codes", () => {
    expect(tidyOutput("\x1b[32m✓\x1b[0m passed \x1b[1mfast\x1b[22m")).toBe("✓ passed fast");
  });

  it("keeps only what a redrawn line shows last", () => {
    expect(tidyOutput("[=   ] 10%\r[==  ] 50%\r[====] 100%\ndone")).toBe("[====] 100%\ndone");
  });

  it("keeps Windows line endings readable", () => {
    expect(tidyOutput("one\r\ntwo\r\n")).toBe("one\ntwo\n");
  });

  it("collapses a long run of the same line to one and a count", () => {
    const out = tidyOutput(["start", ...Array(40).fill("warn: deprecated"), "end"].join("\n"));
    expect(out).toBe("start\nwarn: deprecated\n[previous line repeated 39 more times]\nend");
  });

  it("leaves short runs and blank lines alone", () => {
    expect(tidyOutput("a\na\na\n\n\n\n\nb")).toBe("a\na\na\n\n\n\n\nb");
  });
});

function obs(id: string, turn: number, size: number, masked = false): Observation {
  return { id, tool: "read_file", turn, size, masked };
}

describe("staleObservations", () => {
  it("masks nothing until enough stale output piles up", () => {
    const log = [obs("a", 1, MASK_BATCH_CHARS - 1)];
    expect(staleObservations(log, 1 + KEEP_RECENT_TURNS)).toEqual([]);
  });

  it("masks every large result past the recent turns, together", () => {
    const half = MASK_BATCH_CHARS / 2;
    const log = [obs("a", 1, half), obs("b", 2, half), obs("small", 2, 50), obs("recent", 5, half)];
    expect(staleObservations(log, 5).map((o) => o.id)).toEqual(["a", "b"]);
  });

  it("never masks a result twice", () => {
    const log = [obs("a", 1, MASK_BATCH_CHARS, true)];
    expect(staleObservations(log, 10)).toEqual([]);
  });

  it("names what was cleared and how to get it back", () => {
    expect(maskedNote(obs("a", 1, 12_345))).toBe(
      "[Output of an earlier read_file (12,345 characters) cleared to keep the context lean. Run it again if you still need it.]",
    );
  });
});
