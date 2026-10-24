# Formic runner Action

The runner that does a Formic job in your repository, as a GitHub Action you can read.

- `action.yml` declares the inputs: `job`, `mode`, `ticket`, `cli`, `model`, `from`, `secret`, `prompt`, `report` and `merge`.
- `dist/index.mjs` is built from `src/lib/runner/loop-entry.ts` by `npm run build:loop-entry` (`scripts/build-runner-action.mjs`). It is not minified, keeps function names, has a source map, and its first line names the commit it was built from.
- `release.yml` is the workflow template for the public repository: on a tag it builds from that tag and calls `actions/attest-build-provenance`, so the file can be checked against the source.

`dist/` is a build output and is not committed here.
