import { describe, expect, it } from "vitest";
import { normalizeRepo } from "./repo";

describe("normalizeRepo", () => {
  it.each([
    ["Ghigog/Formic", "Ghigog/Formic"],
    ['"Ghigog/Formic"', "Ghigog/Formic"],
    ["'Ghigog/Formic'", "Ghigog/Formic"],
    ['  "Ghigog/Formic\n" ', "Ghigog/Formic"],
    ["https://github.com/Ghigog/Formic", "Ghigog/Formic"],
    ["https://github.com/Ghigog/Formic.git", "Ghigog/Formic"],
    ["https://www.github.com/Ghigog/Formic/", "Ghigog/Formic"],
    ["github.com/Ghigog/Formic", "Ghigog/Formic"],
    ["git@github.com:Ghigog/Formic.git", "Ghigog/Formic"],
  ])("accepts %j", (raw, expected) => {
    expect(normalizeRepo(raw)).toBe(expected);
  });

  it.each([undefined, null, "", "Formic", "a/b/c", "https://gitlab.com/a/b", "own er/repo"])(
    "rejects %j",
    (raw) => {
      expect(normalizeRepo(raw)).toBeNull();
    },
  );
});
