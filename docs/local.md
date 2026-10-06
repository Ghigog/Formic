# Running Formic on your own machine

Formic runs fully on one computer, with a local database and no sign-in. This
is the cheapest way to use it, and the fastest to start: no Vercel, no Google
Cloud, no Supabase, and no accounts.

## The app

On a Mac there is a **Formic app** in your Applications folder. Double-click it:
it starts the database and the board and opens them in their own window, with
the ordinary macOS controls. The red button quits Formic *and* stops the server;
yellow minimises; green goes fullscreen; `⌘Q` does what the red button does.
Nothing is lost by quitting — the board lives in the database.

It is a thin native window (Swift, plus the web view macOS already ships — no
Electron, nothing to download) around the same local server the rest of this
page describes. Rebuild it with `bash deploy/mac/build.sh`; that directory's
README explains it.

## What you get, and what you give up

**You get:** nothing to pay for, no egress limit (the database is on your
machine — see `docs/database.md`), and no sign-in to configure. It is one
user, working with one GitHub token.

**You give up:**

- **Agents only run while the machine is on and awake.** Close the laptop and
  work pauses until it is back.
- **GitHub cannot reach you.** A webhook needs a public URL, and `localhost`
  is not one, so the CI-driven fix-or-merge loop does not fire on its own:
  results arrive by checking GitHub while the board is open, not instantly.
  Agents running in the repository's GitHub Actions cannot report progress
  live either. Labelling an issue `formic: intake` still works — the board
  polls GitHub for those on its own sweep while it is open, which is exactly
  why the import is polled rather than pushed.
- **Only you can use it.** There is no one else to sign in.

If you want any of those back, that is exactly what `docs/vercel.md` and
`docs/google-cloud.md` are for. See "Is a desktop app worth it?" at the end.

## Start it (no configuration)

```bash
npm install
npm run dev
```

Open http://localhost:3000. That works with nothing else set: the board runs
on an in-memory store seeded with the demo data. State survives a browser
reload but not a server restart.

Agents are not mocked for you: a column with no agent stops and asks for one.
To run the pipelines with no key, set `AGENT_PROVIDER=mock` (see Agents below).

## The board you see

In this mode the board is the demo fixture, not your hosted boards. Your
hosted boards live in whatever database the hosted deployment uses; they show
up locally only if you point `DATABASE_URL` at that same database (which
defeats the point — it brings the egress with it). A database is not shared
between two Formic deployments that have different connection strings.

If you start a fresh local Postgres instead, the server seeds the same demo
board once, then leaves whatever you create alone (`docs/database.md`).

## Sign-in

Local mode has no sign-in: there is one implicit user, and agents act with the
server's GitHub token. `FORMIC_PASSWORD`, if you set it, still puts a shared
password in front of the board (useful if the machine is shared or reachable
on a LAN). Setting `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET`
switches the app to GitHub sign-in, where local mode stops applying.

`FORMIC_SECRET` is not required locally: session signing falls back to the
database URL, then to a fixed local string. Set it anyway if the board is
reachable by anyone but you.

## A real database, so the board survives a restart

The in-memory store forgets everything when the server stops. For durable
state, run Postgres locally and point `DATABASE_URL` at it.

### On Linux (or in the container Formic is usually built in)

```bash
npm run db:local     # starts a throwaway Postgres and prints a DATABASE_URL
npm run db:push      # apply the schema
npm run db:seed      # optional: load the demo board now instead of on first boot
npm run dev
```

`scripts/local-db.sh` initialises a cluster under `/tmp/formic-pgdata`, starts
it on port 5433 with trust auth as the `formic` user, and prints
`postgresql://formic@127.0.0.1:5433/formic`. It is throwaway: delete the
directory to start over. It expects Postgres 16 under `/usr/lib/postgresql/16`
and, as root, runs as the `postgres` user.

### On macOS

`npm run db:local` is written for Linux and **fails on macOS** with
`initdb: command not found` (it hardcodes `/usr/lib/postgresql/16/bin`, which
does not exist on a Mac). Use Homebrew's Postgres instead, and set the URL
yourself:

```bash
brew install postgresql@16
brew services start postgresql@16
createdb formic
export DATABASE_URL="postgresql://$(whoami)@localhost:5432/formic"
npm run db:push
npm run dev
```

`npm run db:seed` is optional here too: a fresh database self-seeds the demo
board on first boot. Stop the database with `brew services stop postgresql@16`
when you are done.

Whichever you pick, put `DATABASE_URL` in `.env` so `npm run dev` and the
`db:*` scripts agree, and check `GET /api/health` — it reports `"database":
"postgres"` when the connection is live and `"memory"` when it is not.

## Agents

- A column with no saved agent gets Claude on the server's
  `ANTHROPIC_API_KEY`; with no key it stops and asks for an agent rather than
  running anything. `AGENT_PROVIDER=mock` is a development and test switch: it
  runs the mock agents against a mock GitHub, so nothing leaves the machine.
  It is never selected implicitly, and never on a board a person is using.
- Saved agent templates are the same as everywhere: each carries its own
  provider key. An agent on an API key runs in the repository's GitHub Actions
  — where the ticket's own budget lives — once the setup pull request is
  merged, and in-process until then, bounded by `DEFAULT_RUN_BUDGET`
  (`docs/agent-execution.md`). Formic installs its own loop entry with that
  workflow, in the same merge, so a job in Actions needs no address of yours to
  fetch anything: this is the one piece of the cloud path a laptop can do
  completely, and it is why the setup pull request is worth merging here.
- CLI agents (Claude Code, Codex, Gemini CLI) still run in the repository's
  own GitHub Actions. They need `GITHUB_TOKEN` with the **`workflow`** scope
  (writing `.github/workflows/formic-agent.yml` needs it), and the repository
  must have that workflow merged once. On first use Formic opens a pull
  request to add it; a person merges it.
- Webhooks cannot reach `localhost`, so **the CI-driven loop is limited
  locally**: there is nothing at a public URL to POST a check result to.
  Point `GITHUB_WEBHOOK_SECRET` and a tunnel (ngrok, `cloudflared`) at
  `/api/webhooks/github` only if you need that loop; otherwise read results on
  GitHub.

## GitHub access

Local mode acts with one credential: `GITHUB_TOKEN`. It is used to clone and
push, to read repositories and issues, and for CLI agents. Give it `repo` and
`workflow` (plus `read:org` if you list organization repositories).

**Set it in the app:** Settings (the avatar, top right) → **GitHub access**. It
is saved into `.env` and takes effect at once — no restart. You can put
`GITHUB_TOKEN` in `.env` yourself instead; it is the same value.

`GITHUB_REPO` sets the default board's repository (`owner/repo`, or the
repository URL — both are accepted); `GITHUB_BASE_BRANCH` defaults to `main`.

Without a token the app still runs, against a mock VCS: the board works, but
nothing leaves the machine, and `/api/health` reports `"github":"mock"`.

## Sandboxes

`SANDBOX_PROVIDER` defaults to `local`, which runs child processes on the host
with host network and filesystem access. **It is not isolation.** It exists so
the system can be built and tested without an E2B account; use
`SANDBOX_PROVIDER=e2b` with `E2B_API_KEY` for anything running model-authored
code you have not read.

## Tests on a Mac

`npm test` runs the whole suite, and it passes on a Mac. Two tests in
`src/lib/vcs/archive.test.ts` build a fixture tarball with the system `tar`,
which differs by platform: macOS writes an AppleDouble `._name` entry beside
every file it archives, and its BSD tar cannot write the `gnu` format at all
("No such format 'gnu'"). The fixture turns the AppleDouble entries off, and
the `gnu` case is skipped only where the local tar cannot make it — reading an
archive is the subject, not the platform's tar — so both still run in full in
CI, on Linux.

## Reset, and health

- In-memory: restart the server and the demo board is back.
- Local Postgres: `dropdb formic && createdb formic && npm run db:push`, and
  the demo board reseeds on the next boot. (`npm run db:restore` can also load
  a backup — see `docs/database.md`.)
- `GET /api/health` is the one call that says what this process actually is:
  database, agents, github, sandbox, webhook, and any config warnings.

## Is a desktop app worth it?

Two different things get called that, and they are worth separating.

**A native window for the board — yes, and that is what `deploy/mac/` builds.**
A few dozen lines of Swift, no Electron, nothing to download, and the board
gets the ordinary macOS controls (quit, minimise, fullscreen) with quit
stopping the server. It costs nothing to run and needs no packaging.

**Packaging Formic as a shipping product** — an installer, code-signing,
auto-update, a bundled database — is not worth it for the problems you would be
trying to solve. It changes none of the trade-offs above: agents still pause
when the machine sleeps, GitHub still cannot reach you without a tunnel, and it
is still one user.

What neither can do is make the board *reachable* or *always on*. That is a
hosting question, and `docs/vercel.md` and `docs/google-cloud.md` are the
answers to it. Run it locally with the app; reach for a server only when you
want it up with the lid closed, or other people using it.
