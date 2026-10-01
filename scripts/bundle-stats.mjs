#!/usr/bin/env node
/**
 * The client JavaScript a Next.js build ships, as `bundle.json`: total and
 * gzipped bytes, and every chunk, largest first. CI writes it after the
 * build and uploads it with the rest of `sentinel-evidence`, where the
 * Performance sentinel reads it. See docs/sentinels.md.
 *
 *   node scripts/bundle-stats.mjs [out]   default: e2e/.evidence/bundle.json
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { gzipSync } from "node:zlib";

const root = join(process.cwd(), ".next", "static");
const out = process.argv[2] ?? join("e2e", ".evidence", "bundle.json");

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (path.endsWith(".js")) yield path;
  }
}

let chunks;
try {
  chunks = [...files(root)].map((path) => {
    const bytes = readFileSync(path);
    return { file: relative(root, path), bytes: bytes.length, gzip: gzipSync(bytes).length };
  });
} catch {
  console.error(`No build at ${root}: run \`npm run build\` first.`);
  process.exit(1);
}
chunks.sort((a, b) => b.bytes - a.bytes);

const bundle = {
  totalBytes: chunks.reduce((n, c) => n + c.bytes, 0),
  gzipBytes: chunks.reduce((n, c) => n + c.gzip, 0),
  chunks,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(bundle, null, 2));
console.log(`${chunks.length} chunks, ${(bundle.totalBytes / 1024).toFixed(1)} kB (${(bundle.gzipBytes / 1024).toFixed(1)} kB gzipped) -> ${out}`);
