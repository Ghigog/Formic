# Timeline calibration findings (EPIC-151)

Measured merge velocity from production, to set the timeline's pace and the
yield grades on real numbers instead of guesses.

## How the numbers were taken

`scripts/merge-velocity.sql` is a single read-only SELECT. Run it in the
database's SQL editor (Supabase or Neon), or with
`psql "$DATABASE_URL" -f scripts/merge-velocity.sql`, and paste the table it
returns below. That is the only step that needs a person; the sections after
it are filled in from the table.

## Results

_Paste the table here._

## Analysis

_To be filled from the results:_

- **Velocity:** median and p90 story points per active day.
- **Cycle time:** median hours per story point.
- **Yield:** the spread across merged epics.
- **Grade thresholds:** proposed S/A/B/C minimums for `GRADES` in
  `src/lib/colony/game.ts` (the yield grade; `src/lib/sentinels/grade.ts` is
  the unrelated sentinel grade). They must not put every merged epic in one
  grade.
- **Minimum history:** how many active days of merges before measured
  velocity replaces the default pace.
- **Heat or pace:** whether the grade should reward heat (the merge
  multiplier) or steady pace.
