# Formic.app — the macOS window

A double-clickable app around the local Formic server. It is a native macOS
window (Swift + `WKWebView` — the web view ships with macOS, so there is no
Electron and nothing to download) showing the board the local server serves.

That buys the ordinary macOS window controls, which a browser tab cannot give:

| Control | Does |
| :-- | :-- |
| 🔴 Red | Quits Formic **and stops the server**. Your work is saved. |
| 🟡 Yellow | Minimise |
| 🟢 Green | Fullscreen (`⌃⌘F` too) |
| `⌘Q` / `⌘W` | Same as red |

Plus a working **Edit** menu (`⌘C`, `⌘V`, `⌘A`) and **View → Reload** (`⌘R`).

**External links open in your browser.** Every outside link in Formic — a pull
request, a provider's key page, a repository — is a `target="_blank"` link, and
a web view drops those unless the app answers them. This one hands them to the
default browser, so they behave exactly as a new tab would.

## Build

```bash
bash deploy/mac/build.sh          # installs to ~/Applications
open ~/Applications/Formic.app
```

Override the destination with `APP_DIR=/Applications bash deploy/mac/build.sh`.
Building needs `swiftc`, which comes with the Xcode command line tools:

```bash
xcode-select --install
```

The app runs **the checkout it was built from**. Built from a git worktree, name
the one you actually run — a worktree has no `node_modules`, so the board cannot
start there, and the window waits on it:

```bash
FORMIC_DIR=~/Documents/personal_apps/Formic bash deploy/mac/build.sh
```

`build.sh` says so at build time if the directory it was given has no
`node_modules`, rather than leaving the window to find out.

## Which database it reads

The desktop app reads **whatever database the checkout is configured with**, so
putting the same `DATABASE_URL` in the checkout and on the server is all it takes
for the two to be one board — the level, the XP and the heat are derived from
the board, so they follow on their own.

```bash
# in the checkout the app was built against
DATABASE_URL="postgresql://…"        # the non-pooling URL: migrations need it
```

`start-formic.sh` prefers a configured database — `DATABASE_URL`, then
`POSTGRES_PRISMA_URL`, then `POSTGRES_URL`, from the environment and then from
`.env` — and leaves it alone. Only when none of them is set does it fall back to
the local Homebrew database, starting Postgres itself. So a checkout pointed at
a hosted database needs no local Postgres at all.

Prisma's CLI reads the environment and not `.env`, so a database configured only
in `.env` is read out of it and exported by `start-formic.sh`.

The icon is built from `deploy/mac/AppIcon.icon`, the octagon "F" the board
draws, in the shape macOS 26 asks for. See below.

## How it fits together

`Contents/MacOS/Formic` is the window. On launch it runs `start-formic.sh` —
the same "make the database and the board available" logic `docs/local.md`
describes: start Postgres if it is not up, make the `formic` database, apply
the schema, then `npm run dev` if the board is not already answering. When the
board answers, the window loads it. On quit it runs `stop-formic.sh`, which
stops that port and nothing else.

The project directory is written to `Contents/Resources/formic-dir` at build
time, because the app lives in `~/Applications` and the project does not.

## The icon

The octagon "F" the board draws, as a real macOS 26 icon. `AppIcon.icon` is an
Icon Composer document — `icon.json` and `Assets/Mark.svg` — and it describes a
mark rather than a picture: the squircle's ground is one fill, the octagon is
another, and each carries a value per appearance. `build.sh` compiles it with
`actool` into `Contents/Resources/Assets.car` (the layers, light and dark) and
`AppIcon.icns` (for anything older), and `Info.plist` names the catalog with
`CFBundleIconName`. That is the arrangement Xcode builds for every app, and it
is what lets the icon follow **Appearance → Icon & widget style** — Default,
Dark, Clear, Tinted — instead of dropping into Apple's "icon jail", the blank
squircle a flat `.icns` is given on macOS 26.

The mark inverts with its ground: a cream squircle around an anthracite octagon
in the light, an anthracite squircle around a cream octagon in the dark. The "F"
is *knocked out* of the octagon rather than drawn on top of it, so it shows the
ground through it, and one drawing serves every appearance.

**Tinted is the exception, and it is why `icon.json` names it.** Under
Appearance → Icon & widget style → Tinted, macOS paints the squircle in the
chosen tint and renders only what is *lighter than the ground* as its light
material — so a dark mark on a light ground collapses into a flat tinted
squircle and the mark disappears. The octagon therefore carries a light value
for `tinted` too, which keeps the mark, inverted against the tint. Drop that
entry and the icon still builds; it just goes blank in Tinted mode.

The "F" is the title's Newsreader (SemiBold), outlined to path data — the same
outline the browser tab's `src/app/icon.svg` carries, so the tab and the Dock
agree. To change the mark, edit `Assets/Mark.svg` and the fills in `icon.json`,
then rebuild. The layer wants geometry only — `fill="none"` in the SVG, the
colour in `icon.json` — because that is what makes it follow the appearance.

Two things worth knowing:

- `actool` comes with **full Xcode**, not the command line tools. Without it the
  build says so and the app gets the generic icon; nothing else fails.
- A rebuilt icon can sit behind the Dock's cache. If the old one lingers, run
  `touch ~/Applications/Formic.app && killall Dock`.

## What it does not do

It does not make Formic reachable from GitHub, and it does not keep it running
with the lid closed. Those are hosting questions — `docs/vercel.md` and
`docs/google-cloud.md`. This is the local way to run it, made easy to start and
stop.
