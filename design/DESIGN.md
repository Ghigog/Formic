# Formic — UI implementation brief

Source of truth for building the Formic front end. The `artboards/` HTML files beside this
brief are the rendered mockups: self-contained, inline-styled, no build step. Open them in a
browser, or read the markup for exact values. Where this brief and an artboard disagree, the
artboard wins.

Screens: `Main` (5-column board), `EpicDrawer` (PRD + DAG), `Sandbox` (live inspector),
`Showcase` (async walkthrough), `Mobile` (390px board), `Foundations` (token sheet).

Each artboard is wrapped in `<x-dc>` and loads `support.js` — that is canvas scaffolding, not
part of the design. Ignore both when porting. Everything inside the fixed-size root `<div>` is
the design.

## Tokens

```
--terracotta      #D96B27   accent: borders, epic chips, logo mark, drag handles
--terracotta-cta  #B5511A   filled buttons only (white label needs 4.5:1; #D96B27 gives 3.4:1)
--clay            #C27803   agent live: pulsing borders, progress fills, dependency trails
--anthracite      #1C1917   primary text, terminal surface, ambient drawer, active tab
--cream           #FBF9F5   page ground
--column          #F4F1EB   column wells
--panel           #F7F4EE   secondary strips (stepper, status bar, doc headers)
--card            #FFFFFF   cards, panels
--border          #E7E5E4   all 1px borders
--text-muted      #57534E   captions, metadata (4.5:1 on cream; do not lighten)
--jade            #2E7D32   merged, tests passing, done
--rust            #E65100   rebasing, conflict resolving, retry
--crimson         #C62828   CI failure, agent blocked
--ant-crimson     #B3261E   the guide ant and the colony's crimson ant only; never a status colour
```

`--ant-crimson` is deliberately not `--crimson`: it is an illustration colour. Components read it
through the `ant-crimson` Tailwind colour or `var(--ant-crimson)`; `COLOR_UNLOCKS` in
`lib/colony/game.ts` must match its value. No component `.tsx` writes a raw 6-digit hex outside
SVG `fill`, `stroke` and `stopColor`; add a token to `globals.css` instead.

Status colour appears in the dot, never the label. Chips are a 12% tint of the status colour
with `#1C1917` text and a 5px dot — that keeps every state legible without darkening per colour.

Dark-mode note: the spec calls for anthracite card surfaces in dark mode. Not mocked yet.

## Type

```
Plus Jakarta Sans   400/500/600/700   UI: card titles 13/500, column headers 11/600 upper +0.1em
Newsreader          400/500/600       editorial: epic titles, PRD body 15/1.65, showcase prose
JetBrains Mono      400/500           ticket ids, commit hashes, file scopes, logs, badges
```

All three from Google Fonts, one `css2` link. Fallbacks: Georgia for Newsreader, system-ui for
Jakarta, `monospace` for JetBrains.

**Scale.** Pick a size from this list; do not choose between values.

```
name        px   use
micro        9   octagon badge counts, size letters (mono)
caption     10   metadata, timestamps, chip text
label       11   column headers, chips, status text
body-sm     12   secondary body, card meta, dense lists
body        13   card titles, default UI text
body-lg     14   drawer and form body
prose       15   PRD and showcase prose (Newsreader)
subhead     16   section titles, mobile body
heading     18   drawer and modal titles
title       20   screen and panel titles
display     22   epic titles, big numbers
display-lg  28   sentinel and colony headline figures
hero        32   sentinel hero figure on mobile
```

**Exceptions** (sizes in use outside the scale):

```
42  keep    sentinel hero figure at sm and up (sentinels.tsx); the one size above 32
8   keep    compact colony strip labels (header-stats.tsx); the smallest legible mono
7   remove  used once; use micro (9)
17  remove  use subhead (16)
19  remove  use heading (18)
21  remove  use title (20)
26  remove  use display-lg (28)
30  remove  use display-lg (28)
```

"Remove" values still exist in code. New work must not add them; they move to the named size
when the screen they sit on is next touched.

## Grid

8px everywhere: 8 / 16 / 24 / 32 / 48. The one exception the spec grants is **12px card
padding**, for vertical density. Board padding 24, column gap 16, card gap 8, column padding 12.
Radii: cards 8, columns 12, chips 999, modals 12.

**Named off-grid values.** Anything not on the grid or in this list is a bug.

```
2   keep    hairline gaps inside dense mono chips
3   keep    vertical padding and gaps of octagon badges and chips; optical balance with 9-11px text
4   keep    half-step gap inside icon + label pairs
5   keep    chip dot (5px) and the gap beside it
7   keep    octagon chamfer, and the horizontal padding that clears it on small badges
34  keep    timeline row height and the header logo box; fits a 20px node plus its border
42  keep    colony nest ant badge; a 40px badge plus its 1px border pair
9   remove  use 8
10  remove  gaps and the trail gutter offset; use 8, or 12 where column padding applies
14  remove  timeline indent; use 16
18  remove  use 16
```

Remove means: do not add new uses, and snap existing ones to the value given when you next touch
the file.

## Custom components

**Octagonal coin badge.** Two nested elements, both clipped to the same chamfered octagon: outer
is the 1px border colour with `padding: 1px`, inner is the fill. Chamfer 7px on small badges,
9-10px on 26px+ nodes.

```css
.oct { clip-path: polygon(7px 0, calc(100% - 7px) 0, 100% 7px, 100% calc(100% - 7px),
                          calc(100% - 7px) 100%, 7px 100%, 0 calc(100% - 7px), 0 7px) }
```

Used for: ticket size (S/M/L), model tag, PR number, EPIC and MERGED labels, column counts,
step-indicator nodes, the logo mark.

**Pheromone dependency trails.** Inline SVG in the gutter left of child tickets: a 1.5px spine at
22% opacity, plus one quadratic branch per child (`M x yStart Q x yMid xEnd yMid`) at 50%. Ochre
for a blocking edge, jade for one that has unlocked. Rows need a fixed height for the curve
endpoints to land — 60px in the board column, 92px in the drawer. Behaviour: trails fade in on
card hover in To Do; when a parent merges, its trail pulses once in jade and the child loses its
blocked styling.

**8-stage stepper.** `repeat(8, minmax(0, 1fr))` grid in the epic drawer. Complete = anthracite
octagon with a check, active = clay octagon breathing on a 2.4s `box-shadow` pulse, pending =
`#E7E5E4` with the stage number. Connector line sits at the node's vertical centre and takes the
colour of the segment ahead of it. Stages: Prompt, PRD Draft, DAG Split, Sandbox Mint, Code Run,
PR Opened, Rebase, Showcase.

**Ambient agent drawer.** 56px anthracite bar pinned to the bottom of every screen: active
sandbox count with three pulsing ochre dots, token usage and throughput, merge-queue state, and a
Terminal toggle. Collapsed to icon + count on mobile.

## Motion

Motion is functional or characterful, never filler. All of it is `@keyframes` in
`src/app/globals.css` (44 blocks), grouped here by what it animates.

```
Agent liveness   clayPulse 2.4s (running card border + box-shadow, active step), dotPulse 1.6s
                 (live-agent dots), trailPulse 2.4s (dependency trail), readyGlow 2.4s (ready
                 tickets), ant-march 0.9s (trail ants)
Board            columnSlideFromRight / columnSlideFromLeft 250ms (column change)
Dig transition   digBoardOutUp/Down, digEarthInFromBelow/Above, digBoardInFromBelow/Above,
                 digEarthOutUp/Down, digBounceUp/Down, digPeekBelow/Above, digTowardIn: 320-460ms
                 phase animations; digScrollNearUp/FarUp/NearDown/FarDown: infinite soil loops
                 (900ms / 2600ms); digFadeOut / digFadeIn 200ms: the reduced-motion stand-ins
Guide ant, tour  guideAntIdle 2.6s, guideAntLegsA/B and guideAntBob 0.19s, guideAntTalk 0.32s,
                 tourBubbleIn 0.22s
Colony           bellWave 900ms, bellGlint 2.6s
Timeline         tlStripe, tlPing 1.8s
Requests         reqFade, reqPop, reqSlideDown
Sentinels        sentinelScan, sentinelBob, sentinelLine, sentinelFade, auditSweep
```

One-shot transitions run 150-460ms, `ease-out`; loops run 0.9-2.6s, `ease-in-out` (`linear` for
scrolls and marches).

**Reduced motion.** Every keyframe is switched off or flattened under
`@media (prefers-reduced-motion: reduce)`.

- CSS: a rule that sets `animation: <name>` needs a matching selector in a reduced-motion block
  that sets `animation: none` (or a fade). Keyframes applied by Tailwind `animate-[...]` in a
  component are gated with `motion-safe:` / `motion-reduce:` or the `.sentinel-motion` class.
  State that motion carried survives another way: a live card keeps its clay border.
  `src/app/reduced-motion.test.ts` enforces this for every `@keyframes`.
- Dig transition: the board fades (digFadeOut / digFadeIn, 200ms) and `.dig-earth` is hidden.
  No earth or scroll loop plays.
- JS: motion driven from script asks `prefersReducedMotion()`, i.e.
  `window.matchMedia("(prefers-reduced-motion: reduce)").matches`, and skips to the end state.
  It is checked in `board/board.tsx`, `board/dig-transition.tsx`, `colony/fx.ts`,
  `colony/bell.tsx`, `onboarding/tour.tsx` and `sentinels/kpi.tsx`. New JS animation must too.

## Screen notes

**Board.** Header 64px: project selector, branch sync tag, epic progress bar, primary CTA.
Columns are equal `flex: 1` wells. Backlog leads with an inline composer (real `<input>`, not a
modal). To Do holds epic accordions whose children are the DAG. In Progress cards carry a clay
border, agent chip, elapsed time, a labelled progress bar and the sandbox id. In Review cards
carry the PR badge, CI chips and, on failure, a two-line log excerpt on anthracite. Done groups
merged tickets under their epic with the showcase CTA.

**Epic drawer.** 1200×864 modal. Left pane 680px, PRD in Newsreader; right pane the child DAG
with file scopes and blocked-by lines on a `#F7F4EE` ground.

**Sandbox inspector.** 760px right slide-over. Status strip (container, image, branch, remaining
budget), streaming terminal on anthracite, live diff below with 9-10% jade/crimson row tints, and
a footer showing attempt count and token spend.

**Showcase.** 1040×880 document modal. PM Agent prose in Newsreader, numbered octagon steps, a
preview-iframe placeholder, merged PR links, and Approve & deploy / Request changes.

**Mobile (<768px).** Board collapses to a sticky pill tab bar with per-column counts; drag is
replaced by a 52px "Advance card" floating button; drawers become full-screen bottom sheets. All
touch targets ≥44px. No fake status bar — the real one renders over this.

## Accessibility

Real `<button>`, `<a href>`, `<input>` + `<label>` throughout, including in static comps. Every
icon-only button has `aria-label`. Body text is 4.5:1 minimum; `#57534E` is the floor for muted
text on cream. Do not use `#D96B27` behind white text.

## What is fiction

Ticket ids, PR numbers, commit hashes, sandbox ids, token counts, timings and log lines are
sample data written to match the PRD's PROT-01 … PROT-08 breakdown. The showcase preview frame is
a marked placeholder. Nothing here implies an API shape.

## Build order

Matches the PRD tickets. PROT-01 is the board shell, columns, cards and the ambient drawer from
`Main`. PROT-02 adds persistence behind it. PROT-03 and PROT-04 fill the Backlog composer and the
To Do DAG, which is where the pheromone trails and the epic drawer come in. PROT-05 through
PROT-07 drive the running/review card states and the sandbox inspector. PROT-08 is the showcase
document.
