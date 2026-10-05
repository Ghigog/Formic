# Handoff — GitHub issues as a way *in*

**Where it stands:** nothing exists. The issue integration is one-way, board →
GitHub, and has been since PROT-07.

- `src/lib/issues/sync.ts` mirrors every Epic as a parent issue and every ticket
  as a sub-issue, keeps a `formic: <column>` label on them, comments the
  moments worth a notification, and closes what shipped. It is driven by
  Formic's own card events (`sync`, `sync.ts:259`), never by GitHub.
- The webhook acts on exactly four events — `check_run`, `check_suite`,
  `workflow_run`, `pull_request` (`src/lib/review/webhook.ts:102,112,122,154`).
  There is no `issues` case, so an issue delivery is dropped and answered
  `{ ok: true, handled: 0, ignored: true }`
  (`src/app/api/webhooks/github/route.ts:50`).
- The VCS boundary can only **write** issues: `createIssue`, `updateIssue`,
  `comment`, `addSubIssue`, `ensureLabel` (`src/lib/vcs/types.ts:174-183`). No
  `listIssues`, no `getIssue` — nothing in the repository has ever read one.
- Work arrives three ways, all in-app: the board's new-item dialog
  (`createBacklogItem` / `createTodoItem`, `src/lib/board/service.ts:444,486`),
  the Assistant's proposed-and-approved actions
  (`src/lib/assistant/actions.ts:82`), and onboarding
  (`src/lib/board/onboarding.ts:52`).

So today a person who already works in GitHub has to retype their issue into
Formic — and then watches Formic file a *second* issue about it. This is the
other direction.

**Read first:** `docs/tasks/PROT-03-product-agent.md` and
`PROT-04-architect-agent.md` (the two intake paths this must reuse, not
reinvent), `docs/database.md` (the select-only rule, and why), `docs/testing.md`,
and `docs/local.md` (why a webhook cannot reach a laptop).

**User story:** As someone who already writes their work as GitHub issues, I
want to label one and have Formic take it from there, so that the board is a
view of my work rather than a second place I copy it into.

### Why the obvious answers are wrong

**"Subscribe to the `issues` webhook."** On the local path — which is where
Formic runs now — GitHub cannot reach `localhost`, so nothing arrives
(`docs/local.md`). A webhook-only import would work for a deployed board and
silently do nothing for a laptop. The import has to be *polled*; the webhook is
an optimisation on top of it, not the mechanism.

**"Import every open issue."** That turns any repository into hundreds of cards
on the first sweep — and imports Formic's own mirrored issues back in, filing
issues about issues. Opt-in has to be explicit, and the label is the opt-in.

**"Create an Epic and let the Product Agent write a PRD."** Wrong shape for one
issue: an issue is already scoped, and the board's existing answer for one
scoped request is `createTodoItem` — one standalone holder Epic plus one ticket,
drafted by the Architect Agent straight from the text (`service.ts:486`). The
Epic-and-PRD shape belongs to the epic-level import (v2), where a parent issue's
sub-issues are the breakdown.

### The decision that matters: adopt, don't duplicate

This is the feature; the rest is plumbing. An imported issue must *become* the
issue Formic already mirrors, not a second one:

- `ensureTicketIssue` (`src/lib/issues/sync.ts`, near line 224) must treat a
  recorded source issue as the issue it would have created, then go on updating
  labels and commenting exactly as it does now.
- Otherwise: issue #42 → ticket T-7 → Formic files issue #88 describing T-7. Two
  issues for one piece of work, and the pull request says `Closes #88`, so the
  person's #42 never closes.

**Recommendation:** record the source number on the ticket and adopt it in the
mirror. For the v2 epic shape, adopt the parent issue on the Epic — which cannot
collide, because a *standalone* holder Epic is filtered off the board
(`prisma-repository.ts:419`), so the mirror never files an issue for one and
`Epic.issueNumber` stays null.

### Where the import runs

| trigger | reaches a laptop | latency | needs |
| :-- | :-- | :-- | :-- |
| Poll in the idle sweep | yes | up to 30 s | one call in a hook that already ticks |
| `issues` webhook | **no** | seconds | a public URL, a secret, a tunnel |
| Both | yes | seconds deployed, 30 s local | both of the above |

**Recommendation:** both, behind one `importIssues(projectId)`. The sweep is
what makes it work at all locally; the webhook is what makes a deployed board
feel immediate. `sweepIdleCards` already ticks every 30 s from
`GET /api/board` and the event stream (`idle.ts:35`, `api/board/route.ts:24`,
`api/events/route.ts:109`), so the sweep costs one call site.

### Data model

One column, and it is the one that closes the loop:

```
Ticket.sourceIssueNumber Int?   // the issue this ticket was imported from
```

Plus the migration, and the repository surface that every field on a ticket
carries: the interface (`src/lib/db/repository.ts` — `TicketDetail` and
`TicketUpdate`), both implementations (`prisma-repository.ts` row type +
`toTicketDetail`, `memory-repository.ts` extras + `toDetail`), and the contract
test. `prisma/migrations/20261005200000_ticket_reviewed_head/` is the most
recent worked example of exactly this change — copy its shape.

Why not reuse `Epic.issueNumber`: that field *is* the mirror's output for the
Epic. Storing an input there would make the mirror believe it had already filed
the issue it still needs to file.

**No new project setting in v1.** The label is a constant,
`formic: intake` next to `LABEL_PREFIX` (`sync.ts:27`). If a person wants to
choose it, that is a per-project boolean-shaped setting and the pattern already
exists — `Project.autoMerge` with `GET`/`PUT /api/settings?projectId=`
(`src/app/api/settings/route.ts:31`, `src/app/settings/page.tsx:21`). One line
in each place, when it is wanted.

### Touchpoints

| file | what goes there |
| :-- | :-- |
| `src/lib/vcs/types.ts` | the read side of the issue block: `issues(state)` and `issue(number)`, returning a small `IssueSummary` (number, id, title, body, state, labels, whether it is a sub-issue). Next to `IssueRef`/`IssuePatch` (`types.ts:135`) |
| `src/lib/vcs/github.ts` | `GET /repos/{repo}/issues` — one page, labelled, open, `since` when there is one. **Filter out pull requests**: GitHub serves pull requests from the issues endpoint, and their number collides with real issues |
| `src/lib/vcs/mock.ts` | the same against the in-memory `MockIssue` map (`mock.ts:82`). The tests drive the mock, so a method without a mock implementation is untestable — and TypeScript fails the build in both clients when the interface grows, which is the guardrail |
| `src/lib/issues/intake.ts` (new) | `importIssues(projectId)`: list, skip, dedupe, and hand each survivor to the existing intake path. In a per-project lane, exactly as `syncIssues` does (`sync.ts:51`) |
| `src/lib/review/webhook.ts` | an `{ kind: "issue", number }` signal for `issues` → `opened`, `labeled`, `reopened`. Drop unlabelled issues and any issue carrying a `formic:` column label *before* it becomes a signal |
| `src/app/api/webhooks/github/route.ts` | the new kind in the `for (const project of projects)` switch (`route.ts:71`), launching the import. The route has no test today; add one |
| `src/lib/board/idle.ts` | the poll, after `startQueued` (`idle.ts:53`), inside the existing `SWEEP_EVERY_MS` gate |
| `src/lib/issues/sync.ts` | the adopt rule, in `ensureTicketIssue` |
| `docs` | README's "Work tracked as GitHub issues" section gains the inbound direction; `docs/local.md` gains the line that the sweep is what makes it work on a laptop |

### Idempotency, and the two loops to close

1. **Two runs for one issue.** A sweep and a webhook, or two sweeps, or two
   instances of the app. `repository().claimDelivery("issue:<full_name>#<n>")`
   — the same idempotency mechanism the webhook and the idle sweep already use
   (`route.ts:68`, `idle.ts:73,87`) — plus the lane.
2. **Importing Formic's own issue.** Two rules, both cheap. Skip a number
   already recorded as a mirror (`epic.issueNumber`, `ticket.sourceIssueNumber`):
   authoritative. Skip an issue carrying a column label or
   `formic: needs a human`: covers the window before the number is recorded,
   and the case where a mirror exists outside this project.

### Reading issues politely

This adds a GitHub read on a 30 s timer, so: one page (100), `state=open`, the
label filter in the query, and `since` from the last successful listing so a
steady state costs one cheap request per project. Skip the whole thing when the
project has no token. Do not put the listing behind `boardCards` — this is a
GitHub call, not a Postgres one, but the same instinct applies: read what is
needed, not everything.

### Acceptance criteria

- [ ] Given an open issue labelled `formic: intake`, when the sweep runs with no
      webhook anywhere in the path, then the board has one ticket for it,
      drafted from the issue's body, and **that issue is the one the ticket is
      tracked by** — no second issue is filed, its label reads
      `formic: <column>`, and the ticket's pull request says `Closes #<that
      issue>`.
- [ ] Given that same issue, when the sweep runs twice more and a webhook
      delivery arrives as well, then there is still exactly one ticket and one
      issue.
- [ ] Given an issue without the label, when the sweep runs, then the board is
      unchanged.
- [ ] Given an issue Formic itself filed for an Epic or a ticket, when the sweep
      runs, then nothing is imported.
- [ ] Given a closed issue, when the sweep runs, then nothing is imported (v1
      reads open issues only).
- [ ] Given a repository whose token has lost Issues access, when the sweep
      runs, then the board still works and the failure is reported once, not per
      card (`syncIssues`'s existing behaviour, `sync.ts:300`).
- [ ] Given the label removed from an issue already imported, then its ticket is
      *not* deleted — the label is a door, not a leash.
- [ ] `npm test`, `npm run typecheck`, `npm run lint` and the Postgres half of
      the repository contract suite all pass, and the new tests fail if the
      adopt rule is removed.

### Tests to write

- `src/lib/issues/intake.test.ts` (new): the label gate, the two skip rules, one
  ticket per issue, delivery-key dedupe, and the adopt rule — assert the mock
  client's issue count did not grow when a ticket was mirrored back.
- `src/lib/review/webhook.test.ts`: an `issues` payload with the label yields the
  new signal; without it, and with a `formic:` column label, yields `[]`.
- `src/lib/board/idle.test.ts`: the sweep imports, and does not import twice.
- `src/lib/issues/sync.test.ts`: the mirror adopts a recorded source issue
  instead of creating one.
- `src/lib/db/repository-contract.test.ts`: `sourceIssueNumber` round-trips
  (add it to the existing update-and-find-by-pull-request case, as
  `reviewedHead` is).

### Verifying it on a laptop

The local path has no webhook, which is the interesting case and the easiest to
check:

```
# a scratch database, so the board's own data is untouched
createdb formic_intake
DATABASE_URL=postgresql://$(whoami)@localhost:5432/formic_intake npx prisma db push
TEST_DATABASE_URL=postgresql://$(whoami)@localhost:5432/formic_intake \
  npx vitest run src/lib/db/repository-contract.test.ts
dropdb formic_intake
```

Then, with `GITHUB_TOKEN` in `.env` and a project on a repository of yours:
label an issue `formic: intake`, load the board (`curl -s
http://127.0.0.1:3000/api/board >/dev/null`), and check by hand that the ticket
appeared and that **the issue it points at is the one you labelled**. Open the
drawer; the Architect Agent should be drafting it. Then run the sweep twice more
and confirm nothing was created the second time.

### Out of scope for v1 — say so, do not half-do it

- **Epic-level import.** A parent issue whose sub-issues are its breakdown →
  an Epic with tickets. v1 reads every labelled issue as one scoped request.
  This is the obvious v2, and the adopt rule already generalises to it.
- **The issue changing the board afterwards.** The title and body are read once,
  at import. Editing the issue does not edit the ticket.
- **Labels moving cards, comments becoming notes, closing the issue closing the
  card.** Formic writes its own labels on every sync, so an inbound label reader
  would fight its own writes. That needs a deliberate design, not a line of
  code.
- Assignees, milestones, GitHub Projects, and any issue Formic did not label.

### Open questions for the person

- One label for everything, or a label per column — `formic: to do` landing the
  issue straight in To Do? The second is more useful and more work.
- Is `formic: intake` the right name, and should a project be able to choose it
  (the `autoMerge` settings pattern), or is a constant enough?
- Should the drawer show where a ticket came from? `sourceIssueNumber` is enough
  to render a link, and it costs nothing to carry.

### Landing it

Standard for this repository: a branch, a PR, CI green before merge
(`.github/workflows/ci.yml` — `lint`, `typecheck`, `test`, and `build` which also
runs the Playwright e2e suite), and deploys stay manual (`#458`). Commit subjects
are full sentences; the body says why, not what. Apply the schema locally with
`npm run db:push`; the migration is for the hosted path
(`npm run db:migrate:deploy`). Keep new reads selected, not whole-row —
`docs/database.md` explains what that rule cost the last time it was broken.


