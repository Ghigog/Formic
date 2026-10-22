import { COLOR_UNLOCKS } from "@/lib/colony/game";

/** Black text on every tint: anthracite. */
export const INK = "#1c1917";

/** How much white a tag fill is mixed with: the raw insect hexes are too dark for black text. */
export const TINT_WHITE = 0.7;

/** Mixes a #rrggbb colour with white; `white` is the share of white, 0..1. */
export function tint(hex: string, white: number = TINT_WHITE): string {
  const mixed = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16);
    return Math.round(c + (255 - c) * white)
      .toString(16)
      .padStart(2, "0");
  });
  return `#${mixed.join("")}`;
}

export type InsectColor = (typeof COLOR_UNLOCKS)[number]["key"];

/** The fixed light fill for an insect-palette colour. */
export function insectTint(key: InsectColor, white: number = TINT_WHITE): string {
  const unlock = COLOR_UNLOCKS.find((u) => u.key === key)!;
  return tint(unlock.hex, white);
}
