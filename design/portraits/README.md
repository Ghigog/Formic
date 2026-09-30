# Sentinel portraits — source art

One SVG per sentinel, named by its roster `id`. A portrait is an SVG body
inlined into the page (no image requests), so these files are the **source**,
not the shipped asset: `npm run build:portraits` turns them into
`src/components/sentinels/portraits.traced.ts`, which `portraits.ts` uses as
the map of portraits the page can draw.

## Status

- **Every sentinel has art, and the art is named for the role.** Twelve
drawings, one per `SENTINELS[].id`, from `tester` to `sales`: the key is the
role and nothing else, so nothing here is named after a character the roster
no longer runs.
- The build step exists — `scripts/build-portraits.mjs`, run by
`npm run build:portraits` and by `npm run build` before `next build`. The
suite fails if the module and this directory disagree, so committed art and
shipped strings cannot drift.
- The convention is a test: `src/components/sentinels/portraits.test.ts` fails
and names the id when a sentinel has no portrait, when a portrait has no
sentinel, when a `.svg` here is named for neither, and when the art and the
generated module have gone out of step. `portraits.render.test.tsx` checks
what the page does with the string: that it parses, that it leaves the ground
to the page, that the figure is the app's ink rather than the white it was
drawn in, and that it carries no motion of its own.

## Which drawing is whose

One drawing per role, and one name per drawing, written into `roster.ts`. The
`who` and `kind` there have to agree with the character in the art — that is
what a rename has to keep true.

| file | the drawing | `who` | sentinel |
| --- | --- | --- | --- |
| `tester.svg` | professor T-Rex, mortarboard, round glasses | Professor O'Chumley | Tester |
| `qa.svg` | doctor zombie | Nasty Toes | QA |
| `architect.svg` | classical column with a stern face | Collum | Architect |
| `secops.svg` | assassin hippie | Twodoodes | SecOps |
| `devops.svg` | weary robot | Waterwheel | DevOps |
| `techops.svg` | friendly rock | Ground Pepper | TechOps |
| `perf.svg` | astronaut monkey | Longfoot Jhan | Performance |
| `a11y.svg` | child knight | Luca L'amico | Accessibility |
| `design.svg` | steampunk caveman | That Barbon | Designer |
| `legal.svg` | demon priest | Licio Maria | Legal |
| `marketer.svg` | farmer alien | Ptoughneigh | Marketer |
| `sales.svg` | cowboy rooster | Turk | Sales |

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
- **Draws no ground.** The page paints that — the sentinel's group tint, from
  `GROUP_GROUND` in the roster — and Inkscape's page colour is not read at all.
- **Strips** the XML prolog, comments, `<metadata>`, `sodipodi:` and
  `inkscape:` attributes, and Inkscape's own ids (`svg1`, `layer1`, `path1`) —
  the ids nothing in the file refers to.
- **Rounds** every coordinate to one decimal place, drops the separators a
  path parser does not need, and writes an axis-aligned line as `h` or `v`.
  The drawing is never re-fitted: the numbers you drew come out a tenth of a
  unit coarser, which is a fiftieth of a pixel where the card draws it.
- **Namespaces** any id you kept with the role key (`tassel` becomes
  `id="tester-tassel"`), because the page inlines one portrait twice — a card
  and the report avatar.

It refuses to guess, and fails loudly, on art that would make the page fetch a
file or run code (`<image>`, `<script>`, `<style>`, an outside `href`, a
`url(http…)` paint), art that moves (`<animate…>`, `<set>`, or a `style`
asking for animation or a transition), art drawn on no canvas, and a `#id`
reference with nothing behind it.

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
   jaw, eye — and give the group an `id`. It survives as `<id>-<group>`, so one
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

## Who paints what

The split is the point of the twelve:

- **The app paints the figure.** The art is drawn white, and a white fill or
  stroke ships as `var(--text)` — so every portrait is dark on a light page and
  light on a dark one, and none of them is a white cut-out on a pale card.
- **The page paints the ground.** `portraitGround(id)` is the sentinel's group
tint — `--clay-chip` for BUILD, `--jade-chip` for OPS, `--panel` for PRODUCT,
`--crimson-chip` for BUSINESS — behind the card header and the round avatar.

A portrait that draws its own ground, or that ships a colour where the marker
belongs, breaks the theme quietly. Both are things the suite checks.

## Size

The twelve portraits are 321,499 characters together, 88,774 gzipped — about
7.4KB gzipped each, against 13,793 characters for all eleven hand-drawn
portraits they replace. The heaviest is the rock (`techops.svg`): 135,448
characters and 18,154 gzipped, because its trace carries the stipple of the
bitmap it was traced from; a looser re-trace would take that down by an order
of magnitude. Every portrait ships in the page's own bundle, so judge them
gzipped and watch what a new one costs.

## Adding or changing a portrait

1. Draw it, export it to `design/portraits/<id>.svg`, commit the export.
2. `npm run build:portraits` — it prints what each portrait costs, and would
   rather fail than guess if the art is drawn on no canvas.
3. `npm test` — the suite fails if the art and the module disagree, or if the
   roster and this directory do not name the same sentinels.
