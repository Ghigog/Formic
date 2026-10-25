# Formic runner Action

The runner that does a Formic job in your repository, as a GitHub Action you can read.

- `action.yml` declares the inputs: `job`, `mode`, `ticket`, `cli`, `model`, `from`, `secret`, `prompt`, `report` and `merge`.
- It runs Formic's loop (`mode: loop`), with `prompt` as the payload, in the job's checkout. The key goes in the step's `env` as `FORMIC_API_KEY`, from an Actions secret, never as an input. When the step sets `FORMIC_REPORT` and `FORMIC_STREAM`, the report and the events are written there too, where the workflow reads them.
- `dist/index.mjs` is built from `src/lib/runner/loop-entry.ts` by `npm run build:loop-entry` (`scripts/build-runner-action.mjs`). It is not minified, keeps function names, has a source map, and its first line names the commit it was built from.
- `release.yml` is the workflow template for the public repository: on a tag it rebuilds the runner from the Formic commit its first line names, fails if that differs from the committed `dist/index.mjs`, and calls `actions/attest-build-provenance`, so the file can be checked against the source.

`dist/` is a build output and is not committed here. The public repository commits it, because an Action pinned by commit runs the files at that commit. Publishing is in `docs/runner-action-release.md`.
