# PROT-09 — Design system foundation

**Status:** proposed (not in source PRD)
**Depends on:** PROT-01
**Size:** M

## Why

The design spec is far more specific than the ticket list. It names a palette,
three typefaces, an 8px grid, octagonal badges, pheromone trails, an 8-stage
stepper and an ambient agent drawer — and not one ticket owns any of it. Left
implicit, the visual identity gets approximated ticket by ticket and never
converges.

## Scope

- Tailwind theme with the named tokens: Terracotta Amber `#D96B27`, Clay Ochre
  `#C27803`, Deep Anthracite `#1C1917`, Parched Cream `#FBF9F5`, Jade Green
  `#2E7D32`, Rust Orange `#E65100`, Crimson `#C62828`.
- Type scale: Plus Jakarta Sans (UI), Newsreader (editorial), Geist Mono
  (logs, IDs, hashes).
- 8px spacing scale enforced; 12px card padding as the one documented
  exception.
- Components: octagonal coin badge, status pill, 8-stage step indicator,
  pheromone trail connector (SVG), ambient agent drawer shell.
- Dark mode: the spec gives Deep Anthracite as the dark card surface but no
  full dark palette. Derive one and get it signed off.

## Acceptance criteria

- No component references a raw hex value.
- The badge, stepper and trail components render in isolation with mock props.
- Light and dark both meet contrast requirements on body text and status
  colors.

## Notes

- Crimson `#C62828` on Deep Anthracite `#1C1917` is about 3.4:1 — under the
  4.5:1 bar for body text. CI failure is the single most important state in the
  app to read correctly. Needs a lighter dark-mode variant.
