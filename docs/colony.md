# The colony: reserve and scouts

Two ideas borrowed from ant colonies. A colony keeps some workers idle on
purpose, as a reserve for emergencies. It also sends scouts out before it
commits to a route, and follows whichever one found the best.

Both are off until the board's owner turns them on, and the board's level
decides how far they can go.

## Colony size and reserve

Set in the Nest (the ant hill in the ambient bar), under Colony.

- **Colony size** caps how many Coder Agents the board runs at once. Off,
  the default, means no cap: only file reservations hold work back, as
  before (`docs/concurrency.md`).
- **Reserve** is how many of those slots routine work may not use. Urgent
  work may: a ticket marked as a bug (or on a bug Epic), or one back from
  review with its pull request open (a CI fix, a review to answer).
- A ticket the colony has no room for waits in In Progress as Up next, like
  one waiting on files, and starts when a slot frees. A ticket larger than
  the whole room starts when nothing else is running.
- A scouting ticket takes one slot per scout while they are out, and one once
  its pick is made.

The rules are in `src/lib/colony/reserve.ts`; the queue applies them in
`src/lib/board/queue.ts`.

## What levels unlock

Levels run to 30, with one unlock at each level after the first. Lv 1 starts
with the Ant, Umber and the Tester. Every level also earns a Queen, and the
rank steps up every three levels (Queen from Lv 28).

| Level | Unlock |
| :-- | :-- |
| 2 | QA (Sentinel) |
| 3 | Beetle |
| 4 | Crimson |
| 5 | Architect (Sentinel) |
| 6 | Least reserve drops to 1 |
| 7 | Ladybird |
| 8 | SecOps (Sentinel) |
| 9 | 3 scouts per ticket |
| 10 | Ochre |
| 11 | DevOps (Sentinel) |
| 12 | Spider |
| 13 | TechOps (Sentinel) |
| 14 | Moss |
| 15 | Least reserve drops to 0 |
| 16 | Performance (Sentinel) |
| 17 | Jade |
| 18 | Moth |
| 19 | Accessibility (Sentinel) |
| 20 | 4 scouts per ticket |
| 21 | Slate |
| 22 | Designer (Sentinel) |
| 23 | Anthracite |
| 24 | Auto-scouting |
| 25 | Legal (Sentinel) |
| 26 | Stag beetle |
| 27 | Plum |
| 28 | Marketer (Sentinel) |
| 29 | Terracotta |
| 30 | Sales (Sentinel) |

The schedule lives in `src/lib/colony/game.ts` (styles and colony rules) and
`src/lib/sentinels/roster.ts` (Sentinels). Before Lv 6 the least reserve is 2,
and a ticket may send 2 scouts before Lv 9.

A reserve below the level's floor is raised to it, and never above the
colony size less one.

## Scouts

Sent from a ticket's drawer while it is in To Do, with everything it
depends on merged (`src/lib/coder/scouts.ts`).

1. **Each scout is a copy of the ticket**, off the board, numbered after it
   (`T-1-s1`, `T-1-s2`). It gets the ticket's notes plus one approach, in
   order: the smallest change, the most robust, the cleanest, a different
   route. Each may run on its own agent template; unset, the column's.
2. **They run like any ticket**, on any path (sandbox, loop job or CLI job),
   each on its own branch. The parent holds the file reservation for all of
   them. A scout opens no pull request: its work stops at its branch.
3. **A scout drops out** when its run fails, finds nothing to do, or needs
   files another ticket is writing. Files nobody holds are added to the
   parent's scope, as for any ticket.
4. **When every scout is back**, those with a change go to the Reviewer
   Agent (`compare` on `ReviewerAgent`, `src/lib/agents/judge.ts`). It judges
   them against the acceptance criteria first, then correctness, fit and
   maintainability, and size only breaks ties. It says why, and notes what
   the others found, which is shared with the repository's agents. With only
   one change back there is nothing to compare. A Reviewer that cannot
   compare (a CLI agent) keeps the smallest change.
5. **The pick becomes the ticket's pull request** and goes through review,
   CI and merging like any other. The ticket's chat says what each scout did.
6. **The person can swap the pick** from the drawer until it merges: the old
   pull request is closed and the new one is reviewed from the start.

If every scout comes back empty, the ticket stops with each scout's reason,
which is also kept as a note. Run again, it is worked the ordinary way.

Moving a scouting ticket out of In Progress calls its scouts back: each stops
at its next turn.

## Auto-scouting

At Lv 24, with a capped colony, the owner can let idle reserve slots scout on
their own. In the idle sweep, when nothing is waiting and at least two slots
are free, the reserve sends two scouts on one ticket: a spike in To Do, or a
ticket whose attempt failed. One at a time. Urgent work that needs the slots
calls them back, and the ticket returns to To Do.
