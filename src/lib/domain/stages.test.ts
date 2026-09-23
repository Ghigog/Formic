import { describe, expect, it } from "vitest";
import { epicProgress } from "./stages";

/** An Epic's place on the lifecycle, carried by its tickets past the DAG. */
describe("epicProgress", () => {
  const epic = { status: "ready", stage: 2 };

  it("follows the furthest ticket, and is working while one runs", () => {
    expect(
      epicProgress(epic, [
        { status: "running", stage: 5 },
        { status: "waiting", stage: 3 },
      ]),
    ).toEqual({ current: 5, working: true });
  });

  it("is past the DAG as soon as it has tickets, and idle while none run", () => {
    expect(epicProgress(epic, [{ status: "ready", stage: 3 }])).toEqual({
      current: 4,
      working: false,
    });
  });

  it("ignores a stalled ticket's stage", () => {
    expect(
      epicProgress(epic, [
        { status: "blocked", stage: 6 },
        { status: "ready", stage: 3 },
      ]).current,
    ).toBe(4);
  });

  it("reaches the showcase once every ticket has merged", () => {
    expect(
      epicProgress({ status: "ready", stage: 3 }, [
        { status: "merged", stage: 7 },
        { status: "merged", stage: 7 },
      ]),
    ).toEqual({ current: 8, working: false });
  });

  it("is working while its own planning agent runs", () => {
    expect(epicProgress({ status: "running", stage: 2 }, [])).toEqual({
      current: 2,
      working: true,
    });
  });
});
