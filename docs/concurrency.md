# Many agents, many people, one repository

Formic runs several Coder Agents at once, and several people can each have a
board on the same repository. Two things go wrong when many hands push to one
repository: two of them edit the same lines (a textual collision), or a merge
goes through cleanly but breaks because each side changed something the other
relied on (semantic drift). Four mechanisms keep both out of the base branch.

## 1. Files are reserved before any code is written

Every ticket declares its file scope: the directory prefixes it may touch
(`src/lib/domain/scope.ts`). A running ticket holds a reservation on those
files, and a ticket that needs any of them waits in In Progress, marked
"Up next", until the one holding them stops.

- **Per repository, not per board.** Reservations are read from every board
  on the repository (`Repository.reservations`), so a ticket on Bob's board
  queues behind one running on Alice's. Moved from its chat, it says so:
  "queued behind HER-1 on @alice's board".
- **Decided once, across server instances.** Starting a ticket, starting the
  queue and widening a running ticket's scope all happen under one lease per
  repository in the database (`src/lib/board/lease.ts`, the `lease` table).
  On Vercel every request can land on its own instance; the lease is what
  stops two of them from both seeing the same files free.
- **Shared surface.** Lockfiles, `package.json`, `tsconfig.json`, the Prisma
  schema and the Next config are the files many tickets want. The Architect
  Agent's graph lets only one ticket that could run concurrently touch them
  (`src/lib/domain/dag.ts`), and the reservation does the rest at run time.
- **Enforced on the diff.** A Coder Agent's change is checked against its
  scope before it is pushed. Work that needs more asks for the files, and gets
  them only if no running ticket on the repository holds them.

A ticket in review holds no reservation: it is not editing a checkout, and
holding one would stall the board for as long as CI takes.

## 2. Stacked pull requests

A ticket that depends on another used to wait for it to merge. Now it can
start as soon as the one it depends on has its pull request open
(`src/lib/domain/stack.ts`):

- It starts from that pull request's branch, and its own pull request targets
  that branch, so each layer's diff is only its own work. Its chat says what
  it is stacked on.
- It can stack on one open pull request only: a branch has one base. With two
  prerequisites still open, it waits.
- It never merges ahead of the one under it. When that one merges (through the
  queue, or by a person on GitHub), the stacked pull request is retargeted to
  the merge target, the target is brought in, and it carries on through review
  and the merge queue like any other (`src/lib/coder/stack.ts`).
- If the one under it starts over on a new branch, the stacked pull request
  can never merge as it is: the sweep stops it and says so.

Queens use the same rule, so a Queen moves a chain along as each layer opens
its pull request rather than as each merges.

## 3. A merge queue that fails closed

One merge in flight at a time per repository and target branch, across every
board and instance (`src/lib/review/merge-lane.ts`). Each merge:

1. brings the target branch into the pull request (GitHub's update-branch, a
   merge commit, never a rebase or force-push);
2. waits for CI on that new head;
3. merges only that exact head (`expectedHeadSha`), so nothing untested lands.

A conflict goes to the Reviewer Agent to resolve (below); red CI goes back
through review with the failing checks and their annotations; a refusal parks
the card in In Review with GitHub's reason. Nothing is forced through. An
approval survives a head that only brought the base in, so a green, approved
pull request is not reviewed twice for it.

A merge that cannot get in line within 90 seconds is left to the pull request
sweep, which comes back to approved, green pull requests on its own.

## 4. Conflicts resolved for intent, not lines

When a pull request conflicts with its base, the Reviewer Agent merges the
base into its checkout and resolves it there (`resolveConflicts` in
`src/lib/review/pipeline.ts`). It is given:

- **diff3 markers**, which carry the common ancestor between the two sides, so
  it can see what each side changed, not only how each ended up;
- **the history of each side**: the commits each made to the conflicted files
  since they diverged, often other tickets from any board on the repository,
  whose subjects and bodies say what they were for;
- **the instruction** to write what both changes would have written had they
  known about each other (a function one side renamed and the other gave a new
  check is the new name with the new check), and to check that the call
  sites, types and tests of whatever either side renamed or added still agree.

A CLI agent in GitHub Actions gets the same through git commands in its own
checkout. The resolution is held to the ticket's scope (plus the conflicted
files), checked for leftover markers, pushed as a merge, and goes through CI
before it can merge. A conflict it cannot resolve without redoing the ticket
waits for a person, with the reason.

## What is not covered

- People pushing straight to the repository outside Formic hold no
  reservations. Their changes still reach a Formic pull request only through
  the merge queue, so a collision with them is caught as a conflict or by CI,
  not before the code is written.
- Each person still has their own board. They see each other's work as
  reservations and on GitHub, not as cards.
