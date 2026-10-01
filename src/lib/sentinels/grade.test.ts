import { describe, expect, it } from "vitest";
import { gradeOf, gradeRose } from "./grade";
import { SENTINELS } from "./roster";

const all = (n: number) => Object.fromEntries(SENTINELS.map((s) => [s.id, n]));

describe("gradeOf", () => {
  it("is F with nobody reporting", () => {
    const g = gradeOf({}, 12);
    expect(g.grade).toBe("F");
    expect(g.done).toBe(0);
    expect(g.next?.grade).toBe("E");
  });

  it("counts an unaudited sentinel as zero", () => {
    const stars = all(5);
    delete stars[SENTINELS[0]!.id];
    // 55 / 12 = 4.58
    expect(gradeOf(stars, 12).grade).toBe("S");
    delete stars[SENTINELS[1]!.id];
    // 50 / 12 = 4.17
    expect(gradeOf(stars, 12).grade).toBe("A");
  });

  it("leaves a locked sentinel out of the average and the total", () => {
    const locked = SENTINELS.filter((s) => s.unlockLevel > 1);
    expect(locked.length).toBeGreaterThan(0);
    const g = gradeOf({ [SENTINELS[0]!.id]: 5 }, 1);
    expect(g.total).toBe(SENTINELS.length - locked.length);
    expect(g.avg).toBe(5 / g.total);
    // Stars on a locked sentinel do not count either.
    expect(gradeOf({ ...all(5) }, 1).sum).toBe(5 * g.total);
  });

  it("lands exactly on a threshold", () => {
    expect(gradeOf(all(4), 12).grade).toBe("A");
    expect(gradeOf(all(3), 12).grade).toBe("C");
    expect(gradeOf(all(5), 12).next).toBeNull();
  });

  it("says how many stars reach the next grade", () => {
    // 36 stars is C; B needs 3.5 × 12 = 42.
    const g = gradeOf(all(3), 12);
    expect(g.next).toEqual({ grade: "B", min: 3.5, need: 6 });
  });

  it("orders grades", () => {
    expect(gradeRose("B", "A")).toBe(true);
    expect(gradeRose("A", "B")).toBe(false);
    expect(gradeRose("F", "S")).toBe(true);
  });
});
