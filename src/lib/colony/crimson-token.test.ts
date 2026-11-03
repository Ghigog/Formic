import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COLOR_UNLOCKS } from "./game";

describe("crimson ant colour", () => {
  it("COLOR_UNLOCKS crimson equals the --ant-crimson token in globals.css", () => {
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    const token = /--ant-crimson:\s*(#[0-9a-fA-F]{6})\b/.exec(css)?.[1];
    const crimson = COLOR_UNLOCKS.find((u) => u.key === "crimson");
    expect(token).toBeDefined();
    expect(crimson?.hex.toLowerCase()).toBe(token?.toLowerCase());
  });
});
