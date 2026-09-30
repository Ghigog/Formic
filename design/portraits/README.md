# Sentinel portraits — source art

One SVG per sentinel, named by its roster `pic` key. A portrait is an SVG body
inlined into the page (no image requests), so these files are the **source**,
not the shipped asset: `npm run build:portraits` turns them into
`src/components/sentinels/portraits.traced.ts`, which `portraits.ts` merges
with the portraits drawn by hand.

## Status

- The build step exists — `scripts/build-portraits.mjs`, run by
  `npm run build:portraits` and by `npm run build` before `next build`. The
  suite fails if the module and this directory disagree, so committed art and
  shipped strings cannot drift.
- The convention is a test: `src/components/sentinels/portraits.test.ts` fails
  and names the key when a roster `pic` has no portrait, when a portrait has
  no `pic`, when a `.svg` here is named for neither, and when the art and the
  generated module have gone out of step. The silent empty card is gone.
  `portraits.render.test.tsx` checks what the page does with the string: that
  it parses, fills its frame at both crops, and brings no motion of its own.
- `rex` is traced from `rex.svg`. The other eleven — `zombie owl cat robot
  vamp snail granny steam octo alien pirate` — are still the hand-drawn
  literals in `portraits.ts`, and **they stay hand-drawn until someone draws
  the art**: tracing them costs roughly 8.4KB gzipped each, about 100KB for the
  set, against 3.4KB gzipped for all eleven today. Worth knowing; not worth
  blocking on.
- **A decision the owner still owes:** this branch renames the Tester's
  persona — "Sir Rexford Tophat" becomes "Professor T-Rex, a tenured
  tyrannosaur" — which changes the voice, and the one-line quote, of every
  Tester audit from here on. The art and the build do not care either way.

## Naming

The filename is the `pic` key in `src/lib/sentinels/roster.ts`:

```
rex  zombie  owl  cat  robot  vamp  snail  granny  steam  octo  alien  pirate
```

Nothing links those two lists but this convention, and the tests above are
what make it safe. A `pic` with no portrait still renders something: a marked
placeholder — the key's initial, in a dashed ring, on the column ground — so a
card reads as *missing* rather than as empty (`portraitFor` in `portraits.ts`).

## What the build does

For every `.svg` here, `npm run build:portraits` writes one entry into
`portraits.traced.ts`:

- **Reads the canvas** from the root `viewBox` (or, failing that, its
  `width` and `height`) and scales it to the 200 the page frames every
  portrait in. The frame never moves; the art is what has to fit it. A
  non-square canvas is scaled by its longer side, which is what
  `preserveAspectRatio="… slice"` does with it, so the frame is never
  letterboxed.
- **Reads the ground** from the document's page colour and writes it in front
  of the drawing as `<rect width="200" height="200" fill="…"/>`.
- **Strips** the XML prolog, comments, `<metadata>`, `sodipodi:` and
  `inkscape:` attributes, and Inkscape's own ids (`svg1`, `layer1`, `path1`) —
  the ids nothing in the file refers to.
- **Rounds** every coordinate to one decimal place, drops the separators a
  path parser does not need, and writes an axis-aligned line as `h` or `v`.
  The drawing is never re-fitted: the numbers you drew come out a tenth of a
  unit coarser, which is a fiftieth of a pixel where the card draws it.
- **Namespaces** any id you kept with the pic key (`tassel` becomes
  `id="rex-tassel"`), because the page inlines one portrait twice — a card and
  the report avatar.

It refuses to guess, and fails loudly, on art that would make the page fetch a
file or run code (`<image>`, `<script>`, `<style>`, an outside `href`, a
`url(http…)` paint), art that moves (`<animate…>`, `<set>`, or a `style`
asking for animation or a transition), art drawn on no canvas, art that
declares no page colour, and a `#id` reference with nothing behind it.

## Drawing rules

1. **Export from Inkscape as-is.** Cruft, decimal precision and the canvas are
   the build step's problem. Do not hand-optimise before committing.
2. **Draw the figure in its own ink.** The colours you draw in are the colours
   that ship: the build copies fills and strokes through and never recolours.
   A portrait is decoration (`aria-hidden`) and does not follow the theme — the
   ground it sits on is its own page colour (rule 3) — so a figure painted in
   a theme ink would go light-on-light the moment the theme flipped. (The rule
   here used to ask for a white figure "the app paints". Nothing read white as
   a marker, so it is retired: draw in `#22303C` if you want what `rex` has.)
3. **Set the page colour to the ground.** In Inkscape: *Document Properties ▸
   Page ▸ Background colour*; leave page opacity at 0 (`rex.svg` does), so the
   page is drawn for you and not exported into the art. That colour is the
   only place the ground survives — the build reads it and bakes it in as the
   portrait's first element, and the card's frame and the avatar paint behind
   the art from that first fill (`portraitGround`).
4. **Group anything you may want to move or recolour while drawing** — tassel,
   jaw, eye — and give the group an `id`. It survives as `<pic>-<id>`, so one
   name still means one thing once twelve portraits are inlined into one page.
   Anything you paint with `url(#…)` has to be defined in the same file; the
   build checks.
5. **Keep the subject inside the safe box.** The card header shows at least the
   middle band of the square (y 32..168 of 200) and the report avatar shows the
   inscribed circle. Corners are cropped, so a portrait reads at both crops or
   at neither — check it in the app, not in Inkscape.
6. **Keep the drawing to itself.** No `<image>`, no `<script>`, no `<style>`,
   nothing fetched, nothing that moves. The page inlines the string, so a
   stylesheet in the art would restyle the page and an image would be a
   request; a portrait that animates would keep moving whatever the reader
   asked for. The build fails on all of it.

## Size

`rex.svg` is 49,697 bytes as exported. The string that ships is 21,729
characters, 8,340 gzipped: 56% off the drawing, 62% off what it cost gzipped.
(The 17,833 the earlier hand conversion managed was the same figure re-drawn
with arcs and quadratics where `rex.svg` has cubics — a change of geometry,
not of precision, and not something a build step should do to your art.)

The eleven hand-drawn portraits are about 1,250 characters each — 13,793
together, 3,444 gzipped — so a traced portrait is the heaviest asset in that
module by an order of magnitude. Judge it gzipped.

## Adding or changing a portrait

1. Draw it, export it to `design/portraits/<pic>.svg`, commit the export.
2. `npm run build:portraits` — it prints what each portrait costs, and would
   rather fail than guess if the art is missing its canvas or its page colour.
3. `npm test` — the suite fails if the art and the module disagree, or if the
   roster and this directory do not name the same pics.

