# Toolchains: what a project needs on a fresh machine

Every machine an agent works on is new: the GitHub Actions job a workflow run
gets, and the E2B sandbox an in-process run clones into. Neither has a
project's engine, compiler or packages. A toolchain is how Formic notices,
from files at the repository root, what a project needs, installs it, and
tells the agent how to run the checks.

The code is `src/lib/toolchains/`. One file per toolchain, listed in
`index.ts`. Nothing else in Formic names a toolchain.

| Toolchain | Marker | Job | Sandbox | CI it proposes |
| :-- | :-- | :-- | :-- | :-- |
| Node | `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` | install packages | nothing (left to the agent, as before) | none |
| Python | `requirements.txt` | `pip install` | nothing | none |
| Godot | `project.godot` | engine, then a first import | engine | import, then tests |

## Where it runs

- **The runner's job** (`formic-agent.yml`, step "Install the project's
  dependencies"). The engine download is cached between runs.
- **An in-process run's sandbox** (`openCheckout`), capped at three minutes
  and never fatal. Only what an agent could not work out for itself runs
  here: Node and Python stay with the agent, Godot's engine does not.
- **The checks workflow** (`formic-checks.yml`), the same script.

All three run the same generated script, so the agent, the sandbox and CI
always have the same engine.

## What the agent is told

Each setup writes what it installed and the commands for the checks to
`~/.formic/checks.md`. Every coding prompt says to read it first. A Godot
project's note names the Godot version, says to import before running
anything on a fresh checkout, and gives the test command for the framework it
found.

## CI for repositories that have none

Without CI the Reviewer Agent has nothing to read: a pull request with no
checks counts as done. So when a repository has no CI (`hasCi`) and one of its
toolchains has checks to propose, the setup pull request also adds
`.github/workflows/formic-checks.yml`. Once merged it is the repository's file;
Formic never replaces it, and proposes nothing once the repository has CI.

## What a repository can add

Everything lives under `.github/formic/`:

- **`setup.sh`**, for what no toolchain could guess: a git-ignored native
  library, a model, a generated file. Runs with bash from the root after
  every toolchain's setup and before the import, on every host. `FORMIC_HOST`
  is `job` or `sandbox`. It can call `formic_note "text"` to add to the agent's
  note and `formic_bin <file> <name>` to put a binary on the PATH. A failure is
  reported and does not stop the run.
- **`godot-version`**, for a Godot project that must run one exact build:
  `4.7.1`, or a whole tag such as `4.8-rc2`. Without it Formic takes the newest
  stable patch of the minor version `project.godot` was saved with.

## Godot specifics

- The engine is the official headless-capable Linux build from
  `godotengine/godot-builds`. The version is resolved with `git ls-remote`, so
  there is no API rate limit on a shared runner.
- The job imports once after setup (`.godot/` is never committed, and a script
  that loads an unimported resource fails). A sandbox leaves the import to the
  agent: a large project's first import can take longer than an in-process run
  has. On a 370 MB project it took about two minutes.
- Test frameworks are a list in `godot.ts` (`GODOT_TEST_RUNNERS`). GUT is the
  one supported today; the first one found wins.
- C# projects are not supported yet: they need the .NET build and an SDK. Setup
  stops and says so in the note.

## Adding a toolchain

1. Write `src/lib/toolchains/<name>.ts` exporting a `Toolchain` (see
   `types.ts`): markers, setup per host, an optional prepare, cache paths, and
   CI steps if Formic should propose CI for it.
2. Add it to `TOOLCHAINS` in `index.ts`.
3. Regenerate `.github/workflows/formic-agent.yml` (the runner workflow test
   says how it differs), and add tests to `toolchains.test.ts`, which runs the
   generated script for real in a scratch checkout.

The runner workflow's version is a hash of its text, so a change here makes
every repository's setup pull request propose the new workflow.
