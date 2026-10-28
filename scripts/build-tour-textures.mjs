#!/usr/bin/env node
/**
 * Bakes the guided tour's textures into images in `public/tour/`.
 *
 * The tour's overlay is dark soil with holes cut where it points, and the
 * holes have rough, crumbled edges. Both come from SVG turbulence. Drawn live,
 * that turbulence is worked out again on every repaint beneath the overlay:
 * on a CPU rasteriser each hole's move stalled the page for most of a second.
 * Baked once into tiles, the page only repeats a bitmap.
 *
 * - `soil.webp`: the soil, opaque, one tile repeated across the screen.
 * - `rough.png`: the noise that pushes the holes' edges about. Lossless,
 *   because its red and green are the displacement, and opaque, so storing it
 *   does not premultiply them.
 *
 * Every turbulence stitches its tile edges, so the tiles repeat without a
 * seam. Run it after changing a filter below:
 *
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE=… node scripts/build-tour-textures.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const OUT = "public/tour";

/** Clumps, veins, pebbles and grain over dark earth. */
const SOIL = `
  <feFlood flood-color="#070504" result="base" />
  <feTurbulence type="fractalNoise" baseFrequency="0.011" numOctaves="4" seed="9" stitchTiles="stitch" result="clumpN" />
  <feColorMatrix in="clumpN" type="matrix" values="0 0 0 0 0.045  0 0 0 0 0.036  0 0 0 0 0.03  0.6 0 0 0 -0.24" result="clumps" />
  <feTurbulence type="turbulence" baseFrequency="0.035" numOctaves="2" seed="21" stitchTiles="stitch" result="veinN" />
  <feColorMatrix in="veinN" type="matrix" values="0 0 0 0 0.02  0 0 0 0 0.014  0 0 0 0 0.01  0 0 0 -2 0.3" result="veins" />
  <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="3" stitchTiles="stitch" result="grainN" />
  <feColorMatrix in="grainN" type="matrix" values="0 0 0 0 0.015  0 0 0 0 0.01  0 0 0 0 0.008  1.4 0 0 0 -0.5" result="darkGrain" />
  <feColorMatrix in="grainN" type="matrix" values="0 0 0 0 0.08  0 0 0 0 0.066  0 0 0 0 0.055  0 1 0 0 -0.72" result="lightGrain" />
  <feTurbulence type="fractalNoise" baseFrequency="0.09" numOctaves="1" seed="40" stitchTiles="stitch" result="pebN" />
  <feColorMatrix in="pebN" type="matrix" values="0 0 0 0 0.06  0 0 0 0 0.048  0 0 0 0 0.038  0 0 3 0 -2.1" result="pebbles" />
  <feMerge>
    <feMergeNode in="base" /><feMergeNode in="clumps" /><feMergeNode in="veins" />
    <feMergeNode in="pebbles" /><feMergeNode in="darkGrain" /><feMergeNode in="lightGrain" />
  </feMerge>`;

/** The edge noise, with its alpha made opaque. */
const ROUGH = `
  <feTurbulence type="fractalNoise" baseFrequency="0.07" numOctaves="2" seed="5" stitchTiles="stitch" />
  <feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0 1" />`;

/**
 * One tile: `size` CSS pixels drawn at `scale` image pixels each, so the
 * grain stays as fine as the live filter drew it on a 2x screen.
 */
const TILES = [
  { file: "soil.webp", primitives: SOIL, size: 512, scale: 2, type: "image/webp", quality: 0.9 },
  { file: "rough.png", primitives: ROUGH, size: 256, scale: 1, type: "image/png" },
];

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
});
const page = await browser.newPage();
mkdirSync(OUT, { recursive: true });
for (const tile of TILES) {
  const px = tile.size * tile.scale;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${tile.size} ${tile.size}">` +
    `<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="${tile.size}" height="${tile.size}">${tile.primitives}</filter>` +
    `<rect width="${tile.size}" height="${tile.size}" filter="url(#f)" /></svg>`;
  const dataUrl = await page.evaluate(
    async ({ svg, px, type, quality }) => {
      const img = new Image();
      img.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = px;
      canvas.height = px;
      canvas.getContext("2d").drawImage(img, 0, 0, px, px);
      return canvas.toDataURL(type, quality);
    },
    { svg, px, type: tile.type, quality: tile.quality },
  );
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  writeFileSync(`${OUT}/${tile.file}`, bytes);
  console.log(`${OUT}/${tile.file}: ${px}x${px}, ${Math.round(bytes.length / 1024)} KB`);
}
await browser.close();
