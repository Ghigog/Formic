# Where CI wall-clock goes

Measured for EPIC-267 ("Make CI faster"), so the fixes target the real long pole.

**Method.** The GitHub Actions jobs API (`/repos/Ghigog/Formic/actions/runs/<id>/jobs`)
for the 8 most recent *successful* `pull_request` runs of `ci.yml`
(runs #2383 and the seven before it). Duration = `completed_at - started_at`
of each job or step. Figures are the **median** across the 8 runs, with the
range in brackets. Queue time is not included.

## Jobs

The jobs have no `needs` between them, so PR wall-clock is the slowest job.

| Job | Median | Range |
| --- | --- | --- |
| **build** | **343 s (5m43)** | 303–386 s |
| test | 266 s (4m26) | 213–332 s |
| lint | 88 s | 70–105 s |
| typecheck | 68 s | 53–87 s |
| audit | 10 s | 6–17 s |
| deploy-test | 5 s | 4–6 s |

Pure job time is ~6 minutes, not 10. The remainder of the perceived ~10 min is
queueing for a runner and the Reviewer/PR round trip, which this spike cannot
see. Of the job time, `build` is the wall-clock.

## Slowest job, slowest step

`build`, step **`npm run test:e2e`: 232 s median (max 260 s)**, which is 68% of
the job and the single biggest step in all of CI.

| `build` step | Median |
| --- | --- |
| `npm run test:e2e` (12 Playwright specs, one worker) | 232 s |
| `npm ci` | 52 s |
| `npm run build` (`next build`, `.next/cache` restored) | 24 s |
| Initialize containers | 14 s |
| Cache restore + save | 4 s + 4 s |
| Boot the production build and probe | 4 s |

Next biggest, `test` job:

| `test` step | Median |
| --- | --- |
| `npm test … --coverage` | 95 s |
| `npx vitest run --sequence.shuffle…` | 94 s |
| `npm ci` | 48 s |
| Initialize containers (Postgres service) | 13 s |
| `prisma migrate deploy` | 2 s |

## Candidate levers

Savings are against wall-clock (the `build` job), rough.

| Lever | Measured cost | Expected saving |
| --- | --- | --- |
| **Playwright specs run serially** (single worker by design, they share one in-memory board) | 232 s | Largest. Splitting the 12 specs across 2–3 jobs (shards, each with its own server and board) cuts it to roughly 80–120 s: **~110–150 s off `build`**. Needs `npm ci` and build repeated per shard (+~75 s each, in parallel), so net ~**60–100 s**; sharing the build as an artifact or a no-build e2e job keeps more of it. |
| `next build` | 24 s (cache already warm) | Little: **<10 s**. Not worth targeting. |
| `npm ci` repeated in 4 jobs | 42–52 s each (cache: npm already on; this is install, not download) | Runs in parallel, so it only matters inside the long pole: caching `node_modules` keyed on the lockfile could save **~30 s** off `build`, ~30 s off `test`. |
| Double vitest run in `test` | 95 s + 94 s | Folding into one shuffled run with coverage saves **~90 s off `test`** (266 → ~175 s). Does not move wall-clock while `build` is slower, but it pays off once `build` is under ~175 s. |
| Postgres contract suite | Not separately timed: it runs inside both vitest runs, with no step of its own. The Postgres container start is 13 s and migrate 2 s. | Unknown. Needs a `vitest --reporter=json` per-file timing to size it; likely a minor share of the 95 s. |

## Summary

- **The long pole is the `build` job, and within it e2e** (`npm run test:e2e`,
  232 s of 343 s). `next build` is **not** the problem (24 s).
- The `test` job is second (266 s) and is dominated by running vitest twice
  (189 s), not by anything in the Postgres setup.
- Because the jobs are parallel, speeding up `test` alone changes nothing until
  `build` drops below it. The order for T3 is: shard or shorten e2e first, then
  fold the vitest runs, then trim `npm ci`.
- Not measured: runner queue time, per-spec e2e durations, and the contract
  suite's own cost. T3 should record per-spec times (Playwright `--reporter=json`)
  before choosing how to split the specs.
