# Testing

Three layers, and a rule for choosing between them: **write the cheapest test
that can fail for the right reason.**

| Layer | Runs in | Lives in | Command |
| :-- | :-- | :-- | :-- |
| Domain | node | `src/**/*.test.ts` | `npm run test:unit` |
| Component | jsdom | `src/**/*.test.tsx` | `npm run test:dom` |
| End to end | Chromium | `e2e/*.spec.ts` | `npm run test:e2e` |

`npm test` runs the first two. They need no server, no database and no
network, and finish in a few seconds. `npm run test:e2e` builds the app and
starts it, so it costs about a minute.

## The split is by file extension, not by directory

`vitest.config.ts` defines two projects. `*.test.ts` runs in node, `*.test.tsx`
in jsdom. A test that renders a component has to be `.tsx` to hold the JSX, so
it lands in the right project without anyone remembering to put it somewhere.

The reverse matters more: `src/lib/domain` is deliberately free of framework
imports and I/O, and running it in a browser-shaped environment would hide an
import that broke that.

## What goes where

**Domain (`*.test.ts`).** Anything in `src/lib` — status transitions, file
scopes, the DAG, fractional ordering, budgets, the repositories. These are the
rules that decide whether something is *allowed*, which is why they have the
most tests.

**Component (`*.test.tsx`).** What a component renders and what it does when
you click it. Two things are worth testing here and easy to miss:

- *Design invariants that a refactor can quietly undo.* The status colour
  belongs in the dot and never the label; the coin badge draws its edge as a
  nested element because `clip-path` would cut a CSS border off at the
  diagonals; the pheromone trail's curve endpoints are arithmetic off a fixed
  60px row. Each of those is a rule someone will "simplify" away.
- *The trigger contract.* A user move must produce exactly one typed
  transition, and a refusal must put the card back. Every later ticket hangs
  off that one event, so `board.test.tsx` pins it with the server replaced by
  a spy.

**End to end (`e2e/*.spec.ts`).** Only what genuinely needs a browser:

- **Drag.** jsdom reports every box as 0×0, so `@hello-pangea/dnd` cannot
  decide where a card landed. There is no way to test a drag below this layer.
- **Layout.** A horizontal scrollbar at 375px is invisible without real CSS.
- **The real round trip.** The board, the API route and the store together.

If a test does not need one of those three, it belongs a layer down.

## Writing a component test

```tsx
import { render, screen } from "@testing-library/react";
import { makeCard } from "@/test/cards";
```

`src/test/cards.ts` builds board cards. Use it rather than
`src/lib/fixtures/board.ts`: the fixtures exist to show every card anatomy on
a running board and will keep changing with the design, so a test that asserts
on them breaks for reasons that have nothing to do with the test. Build the
smallest board the assertion needs.

Three things jsdom needs help with, all handled in `src/test/setup-dom.ts`:

- **`matchMedia`** does not exist, and `useMediaQuery` calls it on mount. Set
  the answer with `setViewportMatches(true)` from `@/test/viewport` before
  rendering a mobile case; it resets after every test.
- **A `Droppable` throws outside a `DragDropContext`.** Render a column with
  `renderInDnd` from `@/test/render`.
- **Both headers are always in the DOM** — the wide one and the mobile app
  bar — with CSS hiding whichever does not apply. A real browser drops the
  hidden one from the accessibility tree; jsdom loads no CSS and sees both, so
  queries that would be unique in a browser can match twice.

## Writing an end-to-end test

```bash
npm run test:e2e              # headless, builds first
npm run test:e2e:ui           # Playwright's UI mode
npx playwright test --project=mobile
```

**State is shared, and the board mutates.** Without a `DATABASE_URL` the whole
run works on one in-memory store in one server process. That is why
`playwright.config.ts` sets `workers: 1` and starts a fresh server per run
(`E2E_REUSE_SERVER=1` opts out, and then you own the state). Within a run,
order still matters: a test that moves a card must put it back, which
`withCardReturned` does through the API rather than by dragging — a restore
that depends on layout can fail for the same reason the test it is cleaning up
after did.

**Moving an epic into To Do starts an agent.** It is the Architect Agent's
trigger, it runs detached, and on the demo board it is a mock that keeps
working after your assertion. A test that is not about the pipeline should
move a ticket, not an epic.

**Below 768px only the active column renders.** A card that moves leaves the
DOM entirely, so `columnOf` cannot find it. Follow it to its tab, which is
what a user does.

Other things worth knowing:

- `gotoBoard` waits on a locator rather than `networkidle`. The board holds an
  SSE connection to `/api/events` open for the life of the page, so the
  network is never idle.
- The drag helper moves the mouse in small steps. `@hello-pangea/dnd` starts a
  drag on a 5px threshold and then tracks the pointer; a single jump from
  source to target is ignored.
- Next renders its own empty `role="alert"` route announcer on every page.
  Assert on the text of an alert, not the role alone.
- The Done column leads with its epic group header, which is not draggable —
  the merged tickets underneath it are.

**Chromium.** If it is pre-installed rather than downloaded by Playwright
(CI images, sandboxes), point at it instead of running `playwright install`:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium npm run test:e2e
```

## Gaps worth filling

Honest list of what is not covered yet, in rough order of value:

1. **The epic drawer and DAG pane.** No component tests at all. The drawer's
   stepper, the PRD pane and the measured pheromone trails in `dag-pane.tsx`
   are the largest untested surface.
2. **The event stream.** `useBoard` and `useBoardEvents` fold SSE events into
   board state, and nothing exercises that fold. A fake `EventSource` in a
   jsdom test would cover it.
3. **Keyboard drag.** `@hello-pangea/dnd` supports space-and-arrows, which is
   the only way to move a card without a mouse. Untested at any layer.
4. **Visual regression.** The board is ported from a fixed artboard, so a
   screenshot comparison against `design/artboards/Main.html` would catch
   drift that no assertion here will. Playwright can do it
   (`toHaveScreenshot`); it needs a decision about where baselines live and
   how much font rendering varies between machines.
5. **Axe.** An accessibility sweep per screen, rather than the hand-written
   role and label assertions scattered through the component tests.
