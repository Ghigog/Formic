# What the Sentinels see

A Sentinel run through an API key reads the code, but it can't run anything.
To make up for that, each audit is handed facts that reading alone wouldn't
show. Facts come from three places:

- **GitHub's API:** CI results, security alerts and the dependency list.
- **The whole repository, worked out in code:** the import map, untested
  files and accessibility pattern checks. The repository is downloaded once
  as a tarball, and every file is checked before any model reads it.
- **The CI artifacts of the base branch's latest finished run:** coverage,
  bundle size, axe scans and screenshots.

Every fact arrives as plain text in the scoring prompt, except screenshots,
which arrive as images. Facts add no extra model calls. If a fact isn't
available (no Actions access, nothing uploaded), the Sentinel is told that,
and it says so in its report instead of guessing why.

A CLI Sentinel runs in GitHub Actions with a shell, so it can find all of
this itself and isn't handed any of it.

## Who gets what

| Sentinel | Facts |
| :-- | :-- |
| Tester | CI results, untested files, coverage |
| QA, DevOps, TechOps | CI results |
| Architect | Import map |
| SecOps | Dependencies, security alerts |
| Performance | Dependencies, bundle size |
| Accessibility | Pattern checks and token contrast, axe scans, screenshots |
| Designer | Screenshots; it may also read SVGs, which the others skip as noise |
| Legal | Dependencies |
| Marketer | Screenshots |
| Sales | Nothing extra |

The `evidence` field of each entry in `src/lib/sentinels/roster.ts` sets
this.

What each fact holds:

- **CI results:** the checks on the base branch head, the annotations of any
  failed checks, and the last 50 runs per workflow: pass/fail counts, median
  duration, and which workflows look flaky. A workflow looks flaky if it gave
  two outcomes on one commit or passed only after a re-run.
- **Dependencies:** `package.json` joined to the npm lockfile: resolved
  versions, deprecated packages, and a licence count. Shipped packages
  outside the common permissive licences are listed by name.
- **Security alerts:** open Dependabot, secret-scanning and code-scanning
  alerts, plus branch protection and repository settings. A secret-scanning
  alert carries the secret itself, so only its type is passed on.
- **Import map:** imports between folders, import cycles, the most-imported
  files and the largest files.
- **Untested files:** source files that no test is named after and no test
  imports, largest first.
- **Pattern checks:** markup patterns such as an image with no alt, or a
  click handler on a `div` with no key handler. Also the contrast of colour
  pairs used on the same element, in every theme.

All of these come from the code alone, so the Sentinel is told to confirm a
finding in the file before reporting it.

## Reading more than the first files

An audit makes three calls:

1. Pick up to 40 files.
2. Read them, then ask for up to 15 more files or line ranges. This call is
   given only paths and outlines, not the code again.
3. Score.

A file longer than its share is cut on a line break. The Sentinel is shown
the line numbers of the declarations it missed, so it can ask for the ones
it needs.

## The artifacts your CI can upload

Formic looks through the newest finished runs on the base branch (up to 10)
for artifacts whose names match `sentinel`, `coverage`, `bundle`, `axe`,
`a11y`, `screenshot`, `playwright` or `lighthouse`. It reads these files from
them:

| File | Format | Read by |
| :-- | :-- | :-- |
| `coverage-summary.json` | Istanbul `json-summary`: Vitest, Jest and nyc all write it | Tester |
| `bundle*.json` | `{ totalBytes, gzipBytes, chunks: [{ file, bytes, gzip }] }`; `scripts/bundle-stats.mjs` writes it for a Next.js build | Performance |
| any other `.json` with a `violations` array | axe-core results, one page or an array of pages | Accessibility |
| `.png`, `.jpg`, `.webp` up to 1.5 MB | Screenshots, up to 10 per audit | Accessibility, Designer, Marketer |

Screenshots go to Claude only. A Sentinel on an OpenAI-compatible provider
is told they weren't sent.

Formic's own CI is the example to copy (`.github/workflows/ci.yml`):

- The `test` job runs with `--coverage` and, on pushes to main, uploads
  `sentinel-evidence-coverage`.
- The `build` job runs `scripts/bundle-stats.mjs` after the build. Its e2e
  run includes `e2e/evidence.spec.ts`, which photographs the main pages in
  both themes and scans each one with axe. On pushes to main, the job
  uploads `e2e/.evidence` as `sentinel-evidence`. The spec only records: an
  axe violation never fails the build.

## Token permissions

A fine-grained token needs these read permissions:

- **Contents:** the tarball and the files.
- **Actions:** runs and artifacts.
- **Dependabot alerts**, **Secret scanning alerts** and **Code scanning
  alerts:** the security section.

Where a permission is missing, that part of the brief says it couldn't be
read.
