import { describe, expect, it } from "vitest";

import { guardedCycles } from "./check-cycles.mjs";

describe("guardedCycles", () => {
  it("keeps a cycle through board/service.ts", () => {
    const cycle = ["review/pipeline.ts", "board/service.ts", "runner/runner.ts"];
    expect(guardedCycles([cycle])).toEqual([cycle]);
  });

  it("keeps a cycle through a file under db/ or domain/", () => {
    const viaDb = ["a.ts", "db/repository.ts"];
    const viaDomain = ["b.ts", "domain/entities.ts"];
    expect(guardedCycles([viaDb, viaDomain])).toEqual([viaDb, viaDomain]);
  });

  it("ignores cycles that avoid service.ts, db/ and domain/", () => {
    expect(
      guardedCycles([
        ["runner/runner.ts", "agents/card-chat.ts"],
        ["agents/service.ts", "agents/other.ts"],
        ["mydb/x.ts", "y.ts"],
      ]),
    ).toEqual([]);
  });
});
