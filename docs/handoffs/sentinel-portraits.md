# Handoff — finish the Sentinel portrait work

**Where it stands:** started on branch `formic/sentinel-tester-portrait` (PR
#203, open). Nothing here is merged. `rex` is converted by hand; everything
below is the gap that leaves.
**Read first:** `design/portraits/README.md` on that branch — it is the drawing
brief, and it names the gap this handoff closes.
**Depends on:** #203 merging, or its files being brought over as-is.

---

**User story:** As the person who owns the Sentinels page, I'd like every
portrait to come from source art, be generated rather than hand-converted, and
fail loudly when one is missing, so that no sentinel can quietly render as an
empty card and a re-drawn figure can never drift from what ships.

### Context

- A portrait is an SVG body inlined into the page — no image requests — held as
  a string in `src/components/sentinels/portraits.ts`, keyed by the roster's
  `pic` (`src/lib/sentinels/roster.ts`). Twelve keys, twelve strings today.
- `sentinels.tsx` wraps each string in a **fixed** `viewBox="0 0 200 200"` with
  `preserveAspectRatio="xMidYMid slice"` (`sentinels.tsx:38`), so the strings
  must be drawn on a 200 canvas whatever canvas the art was made on.
- The ground colour behind a portrait comes from `portraitGround(pic)`, which
  is **the first `fill="…"` in the string**. The card header shows ~46% of the
  square and the report avatar crops the same string into a circle.
- Eleven portraits are compact hand-drawn 200×200 figures, ~1,200 bytes each.
  The twelfth, `rex` (the Tester), is being replaced with a portrait traced from
  source art: a 512-canvas Inkscape export, 49,697 bytes. The committed string
  starts with `<rect width="200" height="200" fill="#ECDFC9"/>` (the export's
  page colour, which is also why the export looks blank outside Inkscape) and
  wraps the art in `<g transform="scale(0.390625)">` — 200 ÷ 512. Optimised to
  one decimal place it is 17,833 characters (−64%), 7,559 gzipped, visually
  identical at every size the app renders.
- **Nothing fails when a `pic` has no portrait.** `PORTRAITS[pic] ?? ""` renders
  an empty frame with no error, no type warning and no test failure, and
  `portraitGround` silently falls back to `#F4F1EB`. The naming convention is
  the only link between the two lists.


### Where the work stands

| Piece | State |
| --- | --- |
| `design/portraits/rex.svg` | committed on the branch, unoptimised export |
| `design/portraits/README.md` | committed: drawing rules + the gap above |
| `rex` in `portraits.ts` | replaced by hand with the traced string |
| `roster.ts` Tester | `who`/`kind`/`persona` rewritten ("Professor T-Rex, a tenured tyrannosaur") |
| `scripts/build-portraits.mjs` | **does not exist** |
| a test for the `pic` ↔ portrait link | **does not exist** |
| the other eleven portraits | still the hand-drawn originals |

Checked on that branch: `npm test` — 827 passed, 0 failed.

### Requirements

1. **Generate the strings.** `scripts/build-portraits.mjs` (the repo's other
   build script lives in `scripts/`, `scripts/build-loop-entry.mjs`) reads
   `design/portraits/*.svg` and writes the strings `portraits.ts` holds, or a
   module it imports. Read the canvas size from the SVG root rather than
   hard-coding 512; scale to 200; prefix the ground rect; strip the XML prolog,
   comments, `<metadata>`, `sodipodi:`/`inkscape:` attributes; round
   coordinates to one decimal place. Expose it as `npm run build:portraits` and
   wire it into `build`, so committed art and shipped strings cannot drift.
2. **Make the link between the two lists a test.** Every `SENTINELS[].pic` has
   a `PORTRAITS` entry, and every `PORTRAITS` key is a roster `pic` — both
   directions, each failing with the offending key named. This is the only
   thing that makes the convention safe.
3. **Draw the missing case, rather than nothing.** A `pic` with no portrait
   should render something a person reads as *missing* — an initial, or a
   marked placeholder in the ground colour — not an empty card.
4. **Decide on the other eleven.** Either trace them from the same brief
   (`zombie owl cat robot vamp snail granny steam octo alien pirate`) or record
   in the README that they stay hand-drawn. Cost if traced: about 17.8KB each
   inline, 7.5KB gzipped — roughly 196KB for the set, against ~13KB for the
   whole module today. Worth knowing; not worth blocking on.
5. **Resolve drawing rule 2, one way or the other.** "Draw the figure in white
   (the app paints it, so a theme can change it)" is written in the README and
   implemented nowhere: nothing reads white as a marker, and the traced `rex`
   carries its own single ink colour (`#22303C`) and its own ground. Either
   build the painting — a themed fill for the figure, driven by the same ink the
   roster already gives each group — and then require traced art to be drawn
   white, or retire the rule and accept that traced portraits keep their colours
   and cannot follow a theme. Do not leave the README asserting what the code
   does not do.
6. **Get the owner's eye on the Tester's voice.** The persona is half of what a
   sentinel *says*: `promptFor` is `persona + task + REPORT_RULES`, and the
   report's one-line quote is the one place it stays in character. Renaming
   "Sir Rexford Tophat, a Tyrannosaurus of impeccable breeding" to "Professor
   T-Rex, a tenured tyrannosaur who insists a claim without a test is just an
   opinion" changes every Tester audit from here on. That is a decision, not a
   merge.

### Acceptance criteria

- [ ] Given a roster `pic` with no portrait, when the suite runs, then it fails
      and names the key.
- [ ] Given the committed source art and a clean tree, when
      `npm run build:portraits` runs, then `portraits.ts` is byte-identical to
      what is committed.
- [ ] Given the Sentinels page, when any card or the report avatar renders,
      then its portrait fills the frame with no letterboxing and no gap, at both
      crops.
- [ ] Given `prefers-reduced-motion`, when the page renders, then the portraits
      are unchanged: the art itself carries no animation.
- [ ] Given the README, when the work is done, then every rule in it matches
      what the code does.

### File scope

`design/portraits`, `src/components/sentinels`, `src/lib/sentinels`, `scripts`,
`package.json`

### Traps worth not rediscovering

- The `viewBox` is fixed at 200 in `sentinels.tsx`: scale the art, do not move
  the frame.
- `portraitGround()` reads the **first** `fill="…"`, so whatever ground a
  portrait carries has to stay first in the string.
- The ground is baked into the traced portrait and banned by the README's rule
  3 at the same time. Pick one before adding eleven more.
- A `scale()`-wrapped traced figure is the heaviest asset in the module by an
  order of magnitude; judge it gzipped, and prefer one decimal place.
- The header crops to a band and the avatar to a circle, so check the art at
  both crops, not in Inkscape.

### Where these requirements come from

Items 1–3 are the gap `design/portraits/README.md` and PR #203's own
description name (the build step it calls for, the test it says does not exist,
the silent empty card). Items 4–6 are what I recommended when this work was
handed over; treat 4 and 5 as decisions for the owner, and 6 as a question that
has to be answered before the branch merges.

