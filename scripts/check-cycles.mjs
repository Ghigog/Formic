#!/usr/bin/env node
/**
 * Fails when a runtime import cycle passes through src/lib/board/service.ts,
 * a file under src/lib/db, or a file under src/lib/domain. Other cycles are
 * listed by madge but do not fail this check.
 *
 * madge reports paths relative to the directory it scanned (src/lib).
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The cycles that contain a guarded file; `cycles` is madge's `--json` output. */
export function guardedCycles(cycles) {
  const guarded = (file) =>
    file === "board/service.ts" || file.startsWith("db/") || file.startsWith("domain/");
  return cycles.filter((cycle) => cycle.some(guarded));
}

function main() {
  // madge exits 1 when it finds any cycle, with the JSON still on stdout.
  let out;
  try {
    out = execFileSync(
      "npx",
      [
        "--yes", "madge", "--circular", "--json",
        "--extensions", "ts,tsx", "--ts-config", "tsconfig.json", "src/lib",
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
    );
  } catch (error) {
    out = error.stdout;
    if (!out) throw error;
  }
  const bad = guardedCycles(JSON.parse(out));
  if (bad.length === 0) {
    console.log("No import cycle passes through board/service.ts, db/ or domain/.");
    return;
  }
  console.error(`${bad.length} import cycle(s) pass through board/service.ts, db/ or domain/:`);
  for (const cycle of bad) console.error(`  ${[...cycle, cycle[0]].join(" > ")}`);
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
