# Timeline calibration findings (EPIC-151)

Measured merge velocity from production, to set the timeline's pace and the
yield grades on real numbers instead of guesses.

## How the numbers were taken

`scripts/merge-velocity.sql` is a single read-only SELECT, run on the
production database on 2026-10-26 (from the Lightsail instance:
`psql "$(sudo cat /opt/formic/shared/local-database-url)"`). It covers every
merge from the first, 2026-09-24, to that day.

## Results

| Metric | Value |
| --- | --- |
| Merged tickets | 414 |
| First merge day | 2026-09-24 |
| Last merge day | 2026-10-26 |
| Active days | 19 |
| SP per active day: median | 55.00 |
| SP per active day: p90 | 180.20 |
| SP per active day: last 14 active days | 09-29=12, 09-30=175, 10-01=159, 10-07=7, 10-09=10, 10-13=18, 10-19=135, 10-20=167, 10-21=104, 10-22=201, 10-23=229, 10-24=147, 10-25=63, 10-26=51 |
| Tickets with a cycle time | 38 |
| Hours per SP: median | 0.05 |
| Hours per SP: p90 | 2.28 |
| Merged epics with a yield | 207 |
| Yield: min / median / p90 / max | 2.00 / 3.00 / 5.00 / 5.00 |
| Yield histogram (0.25 buckets) | 2.00: 41, 2.25: 2, 2.50: 27, 2.75: 8, 3.00: 36, 3.25: 4, 3.50: 20, 3.75: 3, 4.00: 12, 4.25: 3, 4.50: 10, 5.00: 41 |

## Analysis

**Velocity is bursty.** Median 55 SP per active day, p90 180. Days are either
quiet (7 to 18 SP) or busy (100 to 230 SP), with little in between. Only 19
of the 33 calendar days had a merge, so a pace measured over calendar days
(as `buildTimeline` does, dividing by the window's days) reads about 0.58×
the pace on days work actually happens.

**Cycle time is not usable yet.** Only 38 of 414 merged tickets have a real
In Progress entry; the rest predate column tracking or only have synthetic
entries. The median, 3 minutes per SP, says agents are fast once started, but
the sample is too small and too recent to calibrate on.

**Yield cannot fall below 2.0.** The completion bonus equals the story points
merged, so an epic merged at 1× throughout scores exactly 2.0, and the heat
cap (4× at 6 stacks) makes 5.0 the ceiling. The current `GRADES` in
`src/lib/colony/game.ts` (S ≥ 2.5, A ≥ 2, B ≥ 1.5, C below) therefore never
give a B or a C:

| Grade | Current | Share |
| --- | --- | --- |
| S | 164 | 79% |
| A | 43 | 21% |
| B, C | 0 | 0% |

## Proposed grade thresholds

Spread across the range yield can actually take, 2.0 to 5.0:

| Grade | Yield | Epics | Share | Reads as |
| --- | --- | --- | --- | --- |
| S | ≥ 4.5 | 51 | 25% | At or near full heat throughout |
| A | ≥ 3.5 | 38 | 18% | Sustained heat |
| B | ≥ 2.5 | 75 | 36% | Some heat |
| C | < 2.5 | 43 | 21% | Merged at about 1×, no heat |

Every grade gets a real share of the history.
The comment in `buildTimeline` ("an epic merged at 1× throughout grades A")
changes to C.

## Minimum history before measured velocity is used

**10 active days.** Over the last 14 active days, the median of any 3-day
stretch ranges from 10 to 201 SP (20×), 5 days from 12 to 167 (14×) and
7 days from 18 to 147 (8×). At 10 days it settles to 120 to 147 (1.2×). Below
10 active days the timeline should keep its default pace.

Measure it as the median SP per **active** day, not the mean over calendar
days: the median ignores the one-off 200+ days, and counting only active
days keeps idle weekends from halving the forecast pace.

## Heat or pace

**Keep grading heat, with the thresholds above.** Heat is stamped on each
ticket when it merges, so every browser agrees on it, and it already rewards
what the colony is about: merging steadily in one sitting. Pace can't be
graded yet, since cycle time covers only 38 tickets. Revisit once most merged
tickets have a real In Progress entry, roughly a month of tracking. Use pace,
not heat, for the timeline's forecast.
