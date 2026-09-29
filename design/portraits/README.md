# Sentinel portraits — source art

One SVG per sentinel, named by its roster `pic` key. The app inlines portraits
into the page (no image requests), so these files are the **source**, not the
shipped asset: a build step turns them into the strings that get bundled.

**Status.** `rex.svg` was converted by hand and is live. The build step
(`scripts/build-portraits.mjs`) and the test described below do not exist yet.

## Naming

The filename is the `pic` key in `src/lib/sentinels/roster.ts`:

```
rex  zombie  owl  cat  robot  vamp  snail  granny  steam  octo  alien  pirate
```

Nothing links the two lists except this convention, and the failure is silent —
a `pic` with no matching portrait renders an **empty** card with no error, type
warning or test failure. A test that fails when a roster `pic` has no file here
is the only thing that makes the convention safe.

## Drawing rules

1. **Export from Inkscape as-is.** Cruft, decimal precision and the 512 canvas
   are the build step's problem. Do not hand-optimise before committing.
2. **Draw the figure in white.** White is a *marker* meaning "this is the
   figure", not a colour — the app paints it, so a theme can change it. (White is
   also why an export looks blank outside Inkscape: the page colour that made it
   visible while drawing is not exported.)
3. **Do not draw a ground.** The app paints it from a token. A ground baked into
   the art cannot follow a theme, which is exactly what would break dark mode.
4. **Wrap anything you may want to move or recolour in its own `<g id="…">`** —
   tassel, jaw, eye. A single path cannot be animated or recoloured in parts, and
   retro-fitting a group means redrawing the shape.
5. **Keep the subject inside the safe box.** The card header shows the middle
   band of the square (y 32..168 of 200) and the report avatar shows the
   inscribed circle. Corners are cropped.

## Size

`rex.svg` is 49,697 bytes as exported. Optimised to one decimal place it is
17,861 (**−64%**), 7,559 gzipped, and visually identical at every size the app
renders. The eleven hand-drawn originals are ~1,200 bytes each, so a traced
portrait is the heaviest asset in that module by an order of magnitude — worth
knowing, not worth blocking on.
