import { describe, expect, it } from "vitest";
import { blobOf, rectBetween } from "./capture";

describe("capture helpers", () => {
  it("decodes a base64 data URL without fetch", async () => {
    const blob = blobOf("data:image/png;base64,aGVsbG8=");
    expect(blob.type).toBe("image/png");
    expect(await blob.text()).toBe("hello");
  });

  it("refuses what is not a data URL", () => {
    expect(() => blobOf("https://example.com/x.png")).toThrow();
  });

  it("makes a rectangle from a drag in any direction", () => {
    expect(rectBetween({ x: 50, y: 40 }, { x: 10, y: 90 })).toEqual({ x: 10, y: 40, w: 40, h: 50 });
  });
});
