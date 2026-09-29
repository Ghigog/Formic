import { describe, expect, it } from "vitest";
import { compact } from "./compact-number";

describe("compact", () => {
  it("counts in thousands and millions, and leaves small counts alone", () => {
    expect(compact(0)).toBe("0");
    expect(compact(840)).toBe("840");
    expect(compact(12_400)).toBe("12.4k");
    expect(compact(182_400)).toBe("182.4k");
    expect(compact(1_200_000)).toBe("1.20M");
  });
});
