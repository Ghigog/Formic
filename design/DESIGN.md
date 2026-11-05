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
--terracotta-cta  #B5511A   filled buttons only (bg-cta, the only filled-button background) (white label needs 4.5:1; #D96B27 gives 3.4:1)
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

## Dark theme

Opt-in only: set `data-theme="dark"` on the page. There is no toggle and no `prefers-color-scheme`
switch. The ground is drawn from the soil in `public/tour/soil.webp` (hue 10-20, lightness 3-10%,
#110603 to #1b130d), so dark Formic is warm red-brown rather than grey. Every token below overrides the
light value of the same name; tokens not listed (accent, status and ant colours) keep their light values.
Contrast is WCAG 2.x. `text-muted` and every `*-chip-text` must stay at 4.5:1 or more on their surface;
`src/app/dark-theme.test.ts` checks that and that this table matches `globals.css`.

```
--cream              #140B08
--column             #1B110D
--column-line        #2E1E17
--panel              #1B110D
--card               #20150F
--nested             #281A13
--nested-muted       #1B110D
--border             #3D2A20
--border-dashed      #55402F
--hairline           #2E1E17
--track              #2E1E17
--text               #F5EDE4  on card 15.4:1
--text-muted         #C4B3A3  on cream 9.5, column 9.1, card 8.8, nested 8.3
--dot-idle           #7D695A
--epic-chip          #3A1F12
--epic-chip-text     #F0925A  on --epic-chip 6.5:1
--jade-chip          #1A2A1A
--jade-chip-text     #7CC680  on --jade-chip 7.4:1
--jade-wash          #161F15
--jade-line          #34603A
--crimson-chip       #3A1713
--crimson-chip-text  #F59A90  on --crimson-chip 7.6:1
--clay-chip          #36230E
--clay-chip-text     #E8B04A  on --clay-chip 7.7:1
--done-card          #2A1C15
--done-card-line     #3D2A20
```

The colony canvas reads these through `var(--token)` and clears its colour cache when `data-theme`
changes (`colony/fx.ts`), so it recolours with the page.

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
```

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
```

## Custom components

**Buttons.** There is no shared Button component; each file writes its classes, so these are the
sizes to write. Radius is 8 (`rounded-lg`) on every variant; `rounded-md` (6) is for inputs and
menu rows, never a button. Label is 13px semibold (12px on Small, 14px on full-page error screens).

```
variant            height        padding-x   fill / border
Primary            40 (h-10)     14 (px-3.5) bg-cta, white label; no border
Primary compact    36 (h-9)      14 (px-3.5) same, in dialogs, the tour and the calls form
Secondary          40 / 36       14 (px-3.5) border-line, card or cream fill, ink label
Dark               36 (h-9)      14 (px-3.5) anthracite fill, cream label (sentinels)
Small              32 (h-8)      12 (px-3)   either fill, 12px label; card actions, drawer rows
Text               36-40         4-8         no fill or border, muted label, ink on hover
```

Touch targets on mobile rise to 44px (`max-md:size-11` / `h-11`).

**Focus ring.** One global rule in `globals.css`: `:focus-visible` draws a 2px solid outline in
`var(--focus)` (bg-cta) with a 2px offset. Do not remove it with `outline-none` on a
button; inputs swap it for a clay border on focus.

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
Board            columnSlideFromRight, columnSlideFromLeft 250ms (column change)
Dig transition   digBoardOutUp, digBoardOutDown, digEarthInFromBelow, digEarthInFromAbove,
                 digBoardInFromBelow, digBoardInFromAbove, digEarthOutUp, digEarthOutDown,
                 digBounceUp, digBounceDown, digPeekBelow, digPeekAbove, digTowardIn: 320-460ms
                 phase animations. digScrollNearUp, digScrollFarUp, digScrollNearDown,
                 digScrollFarDown: infinite soil loops (900ms near, 2600ms far). digFadeOut,
                 digFadeIn 200ms: the reduced-motion stand-ins
Guide ant, tour  guideAntIdle 2.6s, guideAntLegsA, guideAntLegsB and guideAntBob 0.19s, guideAntTalk 0.32s,
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
- Dig transition: the board fades (digFadeOut, digFadeIn, 200ms) and `.dig-earth` is hidden.
  No earth or scroll loop plays.
- JS: motion driven from script asks `prefersReducedMotion()`, i.e.
  `window.matchMedia("(prefers-reduced-motion: reduce)").matches`, and skips to the end state.
  It is checked in `board/board.tsx`, `board/dig-transition.tsx`, `colony/fx.ts`,
  `colony/bell.tsx`, `onboarding/tour.tsx` and `sentinels/kpi.tsx`. New JS animation must too.

## Sound

Sound is characterful feedback, never required to read the screen: every cue pairs with a visible
change. All of it lives in `src/components/colony/sound.ts` (`SoundEngine`, type `Sfx`). Cues are
synthesised with WebAudio (oscillators and filtered noise through one compressor); there are no
audio files. Screens play a cue with `useColony().sfx(name, v?)`, where the optional `v` is a
number the cue reads (a pitch step, a 0-1 intensity, a roster index). Outside the colony provider
the board swap uses `board/swap-sound.ts`.

**Gesture gating.** Browsers refuse audio before the page is touched, so the engine is silent
until the first `pointerdown` or `keydown` (or `navigator.userActivation.hasBeenActive`). The audio
context is opened inside that gesture. `whenAudible(f)` holds a celebration (epic win, guide-ant
speech) until then, and `muted` says a celebration would currently be silent. The context is
resumed on `visibilitychange` and `focus`, and rebuilt if the system took the audio away.

**Mute control.** One switch for the whole browser: Settings > Sound (`role="switch"`, label
"Sound"), stored under `formic:sound` in localStorage, read through `useSound()` and applied with
`SoundEngine.setEnabled`. Off means `play` returns at once. The guide ant has its own speaker
button in the tour bubble ("Mute the ant" / "Let the ant talk", `formic:tours:voice`); it is
shown as off, with the tooltip "Sound is off in Settings" when the main switch is off.
Sound never replaces visible state, and none of it is gated by reduced motion (it is not motion).

```
cue            trigger
Card and board
pickup         a card is lifted for dragging (board.tsx)
drop           a card is dropped in a column; a card lands after a move; the board swap lands
hover          pointer enters a card or the showcase CTA; colony overlay buttons
click          the showcase CTA; colony overlay buttons
deny           a sentinel run fails (sentinels.tsx)
reject         a move or Queen placement is refused; a card fails or is blocked; a locked bug style is tried
fold, unfold   an epic accordion collapses, expands (board.tsx)
crumble        a card is dropped on the archive zone
Agent and score events (colony.tsx)
mint           an agent is dispatched to a card
unlock         a blocked ticket becomes ready
reveal         an agent finishes a ticket; the epic win panel appears
green          CI passes
bad            a bug is reported (score penalty)
squash         a bug report is squashed; the style test squash; the nest ant is squashed
ding           a ticket merges
mult           the merge multiplier, pitch rises with the stack
blip           score points fly to the counter; timeline ticks; sentinel star count-up (v = pitch step)
decay          a heat stack expires
level          the colony levels up
ready          reserved; no screen plays it
Queens and ants
hiss, pop      a Queen is placed on a card (hiss, then pop as she grows in)
rumble, pop, shimmer, whoosh, slam, boing
               the Queen carry gestures: shake, lift, hover, launch, land, wiggle
skitter        ants leaving the nest (v = tick)
emerge         an ant comes out; a sentinel is summoned
attach, grab, detach, enter, burrow
               ants picking up, carrying and entering cards (fx.ts)
Epic win and timeline
coin, tally, tick, fill, epic, close
               the epic win overlay sequence (tick climbs with v)
stamp, scrub   timeline stamp on a merge; dragging the timeline scrubber (v = direction)
bell           the golden bell is rung (v = swing strength)
Sentinels
sentinelLand   a sentinel card slides in
sentinelVoice  hover or tap on an avatar; one voice per roster id in SENTINEL_VOICES; throttled
kpi            the KPI charts finish loading (only when sound is on)
Board swap
dig, grit, surface   the dig transition: going under, soil passing while it loads, coming up
```

New cues go in `Sfx` with a trigger from the list above's families. Keep them short (under about
0.8s except celebrations), quiet (gain under 0.1 except stamps and slams), and never louder than
`ding`.

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

**Colony.** Not a page: a layer over the board. The nest button in the header opens a 400px
popover (a bottom-aligned dialog "Colony" above the ambient drawer) with rank octagon (LV, rank in
Newsreader, XP bar), bug shapes and colours as locked/unlocked swatches ("unlocks at level N"), the
one row of four equal square tiles (Queens, Scouts, Reserve, Bell; `bg-panel`, at least 44px
tall), each with its mark large and faint behind, its number in Newsreader semibold in front, and
an i in the top-right corner whose note opens full-width under the row and holds the explanation.
The Queens tile is dragged onto a card, the Scouts tile toggles Auto-scout, Reserve only shows (it
is set in Settings), and the Bell tile is a plain flat bell in the same faint clay, hanging from the tile's top edge with no hook, its golden-bell count over it, and its cord and toggle hanging out of the tile's bottom; tapping the bell arms a golden one and turns it gold, and swinging the cord rings it. Errors and
what the bell says show in one line under the row. Then an Archive link. A
timeline panel (region "Timeline") charts merges per day, epic rows, streak and yield; it expands
and collapses and pages Earlier / Later. Merges, unlocks and bugs show floating `+N` pops, rings
and bursts (see Motion and Sound); the golden bell hangs in the header and is swung to notify.
All effects are skipped under reduced motion and the cues need the gesture gate.

**Sentinels.** Full-page region "Sentinels" between the header and the ambient drawer, cream
ground. A grade strip leads: an 84px octagon grade (68px on phones) with the 28/32/42px hero
figure, stars in clay, and a "Summon all N" anthracite button (44px high). Below it, a
horizontally snapping row of 264px sentinel cards (portrait, who, name, stars, "Not audited" or
"out of date"). A locked sentinel shows "Unlocks at Lv N" and is not clickable. Choosing one opens
an Audit report dialog: stars, rubric checks marked Met / Not met / Not scored, findings ("Nothing
flagged" when none), and Audit / Calibrate actions. A KPI section with range tabs and four charts
sits below. Refusals show as a crimson chip banner above the row. Runs show "Auditing N…".

**Onboarding tour.** The guide ant (`ant-crimson`) walks to each target and a bubble
(`role="dialog"`, label "Tour: <title>") explains it; the target is lit and the rest dimmed. Controls:
Next (or Done on the last step), Skip tour, Escape to end, and the speaker toggle. Steps whose target
is not on screen are skipped. Steps with `waitFor` have no Next: the person acts on the lit element.
Tours run once each, in order (login, pick, board), and the rest on first visit to their screen
(settings, timeline, sentinels, sentinel-report, colony). "Guided tours" in Settings replays them.
Text is short, in the ant's voice, and mutters through the `syllable` cue. Under reduced motion the
ant jumps rather than walks.

**Settings.** Page at `/settings`, a single column of cards (`bg-card`, 1px border, 12px radius,
16px padding), each with an 11px upper-case label title: GitHub, Auto-merge, Auto-escalation,
Sharing, Runner, Scout agent, Sound, Guided tours, Board view, run-time budget, Colony, Sentinels,
Effort, Renewal day, Notifications, Desktop app, Access tokens, MCP setup, and a Danger zone last.
Controls are real inputs with labels (checkbox `role="switch"`, steppers with "Fewer / More" aria
labels). Each section saves on change and shows its own error inline (see States). Deep links such
as `/settings#sandbox` land on a section.

**Ticket drawer.** Modal `role="dialog"` "Ticket detail" over a 40% black scrim; click outside or
Escape closes. Full-screen bottom sheet on phones (92dvh); on `sm` and up a centred panel, max 1024px
wide, 85dvh. Header: any problem notice banner (crimson, clay or neutral by severity), key, title
(Newsreader 18/600), the agent's plan steps, size/model/status chips, then card actions (Archive,
epic link, close). Body is two panes, `Ticket` (user story, why, what, how, acceptance criteria,
attachments) and `Agent` (live thinking and actions, usage, KPIs, scouts, Queen, follow-ups, chat);
side by side on desktop, tabbed on phones. The drawer follows the keyboard inset so inputs stay
visible. Epics use the Epic drawer instead.

## States

One set of rules for what a screen shows while it has nothing, is waiting, or has failed. Use these
instead of inventing a new treatment.

**Empty.** One quiet sentence in `text-muted`, 12-13px, no illustration, no button unless a single
action fixes it. Say what will fill the space and what makes it appear. Seen today: "No child
tickets yet. Move this Epic to To Do and the Architect Agent…" (DAG pane), "No epics with tickets
yet. Once the Architect Agent breaks one…" and "No merges yet" (timeline), "Nothing yet. The
commands agents run, and what they print, show here as they work." (terminal), "Nothing flagged"
(sentinel findings), "Came back empty" (scout). Charts with no data say so in place of the chart, under their title.

**Loading.** Show the real container with a text placeholder, never a spinner or skeleton blocks.
Titles read "Loading…" (ticket and epic drawers) until the card arrives. Inline waits use three
1.5-unit clay dots with `animate-pulse` (chat) or pulsing muted text.
A board swap uses the dig transition with a polite live region ("Loading <board>"). Sentinel runs
show "Auditing N…" on the button. Every pulse is gated for reduced motion; the words stay.

**Error.** Inline, next to the thing that failed, with `role="alert"`, in plain words that say what
did not happen and what is still true. Never a toast for form errors, never a modal.
- Field or section save: 11px crimson text under the control (`text-crimson-text` on light cards,
  `text-log-error` on anthracite surfaces).
- Panel-level: a 12-13px message on a `bg-crimson/10` or `bg-crimson-chip` strip with `rounded-md`.
- Notices about a card (blocked, failed, stalled): the banner at the top of the card and ticket
  drawer, severity-coloured, with an icon, a bold title and one line of detail.
- A whole load that failed: one muted sentence ("KPIs could not be loaded."; "Couldn't load that
  board. You're back on the previous one.") and the previous state stays usable.
- A missing setup step (no sandbox key) uses a `bg-clay/15` strip with a link to fix it.
- Route failures use `app/error.tsx`, `app/global-error.tsx` and `app/not-found.tsx`.
Status colour still lives in the dot or icon; the message text stays `#1C1917` or `text-crimson-text`.

## Accessibility

Real `<button>`, `<a href>`, `<input>` + `<label>` throughout, including in static comps. Every
icon-only button has `aria-label`. Body text is 4.5:1 minimum; `#57534E` is the floor for muted
text on cream. Do not use `#D96B27` behind white text: `bg-cta` (#B5511A) is the only
filled-button background.

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
