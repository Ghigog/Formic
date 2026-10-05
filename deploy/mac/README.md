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

The icon is rendered from `src/app/icon.svg`, so it tracks the app's own mark.

## How it fits together

`Contents/MacOS/Formic` is the window. On launch it runs `start-formic.sh` —
the same "make the database and the board available" logic `docs/local.md`
describes: start Postgres if it is not up, make the `formic` database, apply
the schema, then `npm run dev` if the board is not already answering. When the
board answers, the window loads it. On quit it runs `stop-formic.sh`, which
stops that port and nothing else.

The project directory is written to `Contents/Resources/formic-dir` at build
time, because the app lives in `~/Applications` and the project does not.

## What it does not do

It does not make Formic reachable from GitHub, and it does not keep it running
with the lid closed. Those are hosting questions — `docs/vercel.md` and
`docs/google-cloud.md`. This is the local way to run it, made easy to start and
stop.
