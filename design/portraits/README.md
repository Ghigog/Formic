# Sentinel portraits — source art

One SVG per sentinel, named by its roster `pic` key. A portrait is an SVG body
inlined into the page (no image requests), so these files are the **source**,
not the shipped asset: `npm run build:portraits` turns them into
`src/components/sentinels/portraits.traced.ts`, which `portraits.ts` uses as
the map of portraits the page can draw.

## Status

- **Every `pic` has art.** All twelve are traced from this directory; the
  eleven hand-drawn literals that used to fill the gaps are gone — they are in
  git history if you ever want one back.
- The build step exists — `scripts/build-portraits.mjs`, run by
  `npm run build:portraits` and by `npm run build` before `next build`. The
  suite fails if the module and this directory disagree, so committed art and
  shipped strings cannot drift.
- The convention is a test: `src/components/sentinels/portraits.test.ts` fails
  and names the key when a roster `pic` has no portrait, when a portrait has
  no `pic`, when a `.svg` here is named for neither, and when the art and the
  generated module have gone out of step. `portraits.render.test.tsx` checks
  what the page does with the string: that it parses, that it leaves the
  ground to the page, that the figure is the app's ink rather than the white
  it was drawn in, and that it carries no motion of its own.

## Which drawing is whose

The `pic` keys are the roster's, so several no longer describe the drawing —
the friendly rock is keyed `vamp` because that is the TechOps slot. Renaming
them is a rename across the roster, these files and the generated module; say
the word.

| `pic` | the drawing | sentinel |
| --- | --- | --- |
| `rex` | professor T-Rex, mortarboard, round glasses | Tester |
| `zombie` | doctor zombie — "Nasty Toes" | QA |
| `owl` | a classical column with a stern face — "Collum" | Architect |
| `cat` | an assassin hippie — "Twodoodes" | SecOps |
| `robot` | a weary robot — "Waterwheel" | DevOps |
| `vamp` | a friendly rock — "Ground Pepper" | TechOps |
| `snail` | an astronaut monkey — "Longfoot Jhan" | Performance |
| `granny` | a child knight — "Luca L'amico" | Accessibility |
| `steam` | a steampunk caveman — "That Barbon" | Designer |
| `octo` | a demon priest — "Licio Maria" | Legal |
| `alien` | a farmer alien — "Ptoughneigh" | Marketer |
| `pirate` | a cowboy rooster — "Turk" | Sales |

Two things still owed, both the owner's:

- **The names.** `who`, `kind` and `persona` in the roster still describe the
  old characters — the Architect is keyed to the column but still says
  "Professor Hootsworth" — and the branch's first commit renamed the Tester
  without sign-off.
- **The Tester's new drawing.** `professortrex.svg` arrived as a whole-document
  export: ten traced layers (one of them byte-identical to the rock) plus ten
  embedded JPEGs, 7.4MB. The build refuses it, and rightly — so `rex.svg` is
  still the original traced professor T-Rex. Export that one character on its
  own canvas to replace it.

## What the build does

For every `.svg` here, `npm run build:portraits` writes one entry into
`portraits.traced.ts`:

- **Reads the canvas** from the root `viewBox` (or, failing that, its `width`
  and `height`) and scales it to the 200 the page frames every portrait in.
  The frame never moves; the art is what has to fit it. A non-square canvas is
  scaled by its longer side, which is what `preserveAspectRatio="… slice"`
  does with it, so the frame is never letterboxed.
- **Paints the figure.** A white fill or stroke is the marker that means "this
  is the figure": it ships as the app's ink, `var(--text)`, so the figure reads
  against its ground in either theme. A colour you set deliberately ships as
  you set it.
- **Draws no ground.** The page paints that — the sentinel's group tint — and
  Inkscape's page colour is not read at all.
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
asking for animation or a transition), art drawn on no canvas, and a `#id`

## Drawing rules

1. **Export from Inkscape as-is.** Cruft, decimal precision and the canvas are
   the build step's problem. Do not hand-optimise before committing.
2. **Draw the figure in white.** White is a *marker*, not a colour: the build
   ships it as the app's ink (`var(--text)`), so the figure reads against the
   ground in either theme and a theme can change it. Any other colour you set
   ships as you set it. White on a transparent page is also why one of these
   exports looks blank outside Inkscape — the colour you drew against is the
   page's, and the page is not exported.
3. **Do not draw a ground.** The app paints it from a token — the sentinel's
   group tint (`portraitGround`), behind both the card header and the round
   avatar — because a ground baked into the art cannot follow a theme. Nothing
   in Inkscape's page settings reaches the portrait.
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

The twelve portraits are 320,982 characters together, 88,743 gzipped — about
7.7KB gzipped each, against 13,793 characters for all eleven hand-drawn
portraits they replace. The heaviest is the rock, keyed `vamp`: 135,448
characters and 18,154 gzipped, because its trace carries the stipple of the
bitmap it was traced from; a looser re-trace would take that down by an order
of magnitude. Every portrait ships in the page's own bundle, so judge them
gzipped and watch what a new one costs.

## Adding or changing a portrait

1. Draw it, export it to `design/portraits/<pic>.svg`, commit the export.
2. `npm run build:portraits` — it prints what each portrait costs, and would
   rather fail than guess if the art is drawn on no canvas.
3. `npm test` — the suite fails if the art and the module disagree, or if the
   roster and this directory do not name the same pics.

reference with nothing behind it.
