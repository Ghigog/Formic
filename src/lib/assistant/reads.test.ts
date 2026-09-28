import { describe, expect, it } from "vitest";

import { READ_WINDOW, outOfRoundsMessage, readWindow } from "./reads";

/** A long file with the part that matters in the middle, the way a long one is. */
function longDoc(): string {
  return "x".repeat(20_000) + "\n## The epic\nCL-1 price the models\n\n## Tickets\nCL-1 ...\n" + "y".repeat(14_000);
}

describe("readWindow", () => {
  it("hands back a file that fits in one window untouched", () => {
    const text = "one line\n";
    expect(readWindow("docs/short.md", text)).toBe(text);
  });

  it("says which characters it is showing, and how to carry on", () => {
    const text = longDoc();
    const first = readWindow("docs/cline-audit.md", text);
    expect(first.startsWith(`[docs/cline-audit.md: characters 0-${READ_WINDOW} of ${text.length}]`)).toBe(true);
    expect(first).toContain(`[More: call read_file with offset=${READ_WINDOW}.]`);
    expect(first).not.toContain("## The epic");
  });

  it("reaches the middle when asked for the offset it named", () => {
    const second = readWindow("docs/cline-audit.md", longDoc(), READ_WINDOW);
    expect(second).toContain("## The epic");
    expect(second).toContain("## Tickets");
  });

  it("walks a long file in windows that together are the whole file", () => {
    const text = longDoc();
    let offset = 0;
    let joined = "";
    for (let step = 0; step < 10; step++) {
      const window = readWindow("docs/long.md", text, offset);
      joined += window.split("\n").slice(1).join("\n").replace(/\n\[More: [^\]]*\]$/, "");
      const more = /offset=(\d+)\.\]/.exec(window);
      if (!more) break;
      offset = Number(more[1]);
    }
    expect(joined).toBe(text);
  });

  it("says when the offset is past the end", () => {
    expect(readWindow("docs/short.md", "abc", 99)).toBe(
      "[docs/short.md is 3 characters; offset 99 is past the end. Read from 0.]",
    );
  });

  it("treats a negative offset as the start", () => {
    const text = longDoc();
    expect(readWindow("docs/long.md", text, -5)).toBe(readWindow("docs/long.md", text, 0));
  });
});

describe("outOfRoundsMessage", () => {
  it("counts the files and the rounds", () => {
    expect(outOfRoundsMessage(["a.md", "b.md"], 16, null)).toBe(
      "I read 2 files over 16 rounds and did not reach an answer. Try a narrower question, or name the file and section you mean.",
    );
  });

  it("says one file for one file", () => {
    expect(outOfRoundsMessage(["a.md"], 16, null)).toContain("I read 1 file over 16 rounds");
  });

  it("passes on the last thing a tool said", () => {
    expect(outOfRoundsMessage([], 16, "docs/x.md does not exist on main.")).toBe(
      'I read 0 files over 16 rounds and did not reach an answer. The last thing a tool told me was: "docs/x.md does not exist on main." Try a narrower question, or name the file and section you mean.',
    );
  });
});
