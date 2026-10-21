import { describe, expect, it } from "vitest";

import { isGoAgain, outOfRoundsReply, outOfTimeReply } from "./card-chat";

describe("what a chat says when it ran out", () => {
  const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts", "h.ts"];

  it("says it got nowhere, and what it read, when it has nothing to say", () => {
    expect(outOfRoundsReply(5, [], "  ")).toBe(
      "I used all 5 rounds and did not reach an answer. Ask me again, narrower, or name the file and section you mean.",
    );
    expect(outOfRoundsReply(5, ["a.ts"], "")).toContain(" I read 1 file: a.ts.");
    expect(outOfTimeReply(4 * 60_000, files, "")).toContain("I ran out of time (4 minute limit)");
    expect(outOfTimeReply(4 * 60_000, files, "")).toContain("I read 8 files: a.ts, b.ts, c.ts, d.ts, e.ts, f.ts, and 2 more.");
  });

  it("keeps what it did say, then adds the cost", () => {
    expect(outOfRoundsReply(3, files, " Probably the cache. ")).toBe(
      "Probably the cache.\n\nI used all 3 rounds getting there. I read 8 files: a.ts, b.ts, c.ts, d.ts, e.ts, f.ts, and 2 more.",
    );
    expect(outOfTimeReply(120_000, [], "Probably the cache.")).toBe(
      "Probably the cache.\n\nI ran out of time (2 minute limit) before I finished.",
    );
  });
});

describe("isGoAgain", () => {
  it.each(["continue", "Please retry", "try again please", "pick it back up!", " go ahead. "])("takes %j", (text) => {
    expect(isGoAgain(text)).toBe(true);
  });

  it.each(["continue with the tests instead", "why did it stop", ""])("leaves %j to an agent", (text) => {
    expect(isGoAgain(text)).toBe(false);
  });
});
