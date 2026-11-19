# Playtest: try what the colony built, and say what's wrong

**Status:** built 2026-11-18. Waiting on a first run against a real E2B sandbox in production. Tick boxes as work lands; this file is the
memory of the plan, so keep it current.

## Why

Done is where work ends up, and today nothing in Formic lets you use it. You
leave for a terminal or a deploy to find out whether the game plays or the app
works, and what you find there comes back to the board as a hand-typed
request, if it comes back at all.

Playtest runs the default branch in a throwaway E2B sandbox and shows it inside
Formic, with the PM beside it. You play, you write a note when something looks
wrong, you drag a screenshot onto it, and the PM tells you whether it's a bug
worth a ticket, already known, or intended. Nothing becomes a ticket until you
press Approve.

## Where you find it

- **Done column, in the agent-picker slot** the other columns have
  (`src/components/board/column.tsx`, the `agent` row). Done has no agent of
  its own (`board.tsx`, `columnAgents` skips it), so the slot is free. One
  full-width button: a play icon and **Playtest**.
- **Unlocks at Lv 15.** A new `FEATURE_UNLOCKS` entry,
  `{ key: "playtest", lv: 15 }` (`src/lib/colony/game.ts`). Below Lv 15 the
  slot stays empty, like every other locked feature. The colony's "next
  unlock" names it on the way. Lv 15 because by then several Epics have
  merged, so there is a real product to play, and the person knows the loop
  from Timeline (Lv 10). **Unlock everything** in Settings opens it early.
- **The ant introduces it.** At Lv 15 the button rises in with `FeatureReveal`
  (ring, burst, celebration cue), then the `playtest-intro` tour
  (`src/components/onboarding/tours.ts`) points at it, with its column set to
  `done` so a phone brings Done up first.
  - With an E2B key: "Playtest! Try what your colony built, live in its own
    sandbox. Write notes as you play and I'll sort out what needs fixing."
  - Without one: "Playtest runs in an E2B sandbox, on your own key. Add it in
    Settings and this button wakes up."

### Button states

| State | Looks like | Pressing it |
| :-- | :-- | :-- |
| Locked (below Lv 15) | Not there | — |
| No E2B key of your own | Grayed, small lock | A popover: "Playtest runs in an E2B sandbox on your own key. Add it in Settings." with a button to `/settings#sandbox` |
| Nothing merged yet | Grayed | "Nothing shipped yet. Playtest opens once a ticket has merged." |
| Ready | Normal, "default branch" | Opens the Playtest screen and starts a session |
| Running | A live dot and the time left | Reopens the running session |

## The Playtest screen

A full-screen room over the board, like Timeline and Sentinels. Same tab: the
chat is the point, and a new tab would cut it off. **Open in new tab** is
there for anyone who wants it.

```
┌──────────────────────────────────────────────────────────────┬───────────────────────┐
│ ■ Stop  ⌗ Screenshot  ↻ Restart•   abc1234 · 14:32 left      │  ☰ Sessions   ↗  ✕    │
├──────────────────────────────────────────────────────────────┼───────────────────────┤
│                                                              │ PM                    │
│                                                              │  T-42 merged. Restart │
│                  the game or app, in a frame                 │  to play it.          │
│                                                              │                       │
│                                                              │ You  [Playtest]       │
│                                                              │  The jump feels late. │
│                                                              │  [screenshot]         │
│                                                              │                       │
│                                                              │ PM  Intended: the PRD │
│                                                              │  asks for coyote time │
│                                                              │  ...                  │
│                                                              ├───────────────────────┤
│                                                              │ [screenshot chip]     │
│                                                              │ Write a note…      ⏎  │
└──────────────────────────────────────────────────────────────┴───────────────────────┘
```

- **Left, most of the width:** the product in an iframe.
- **Right, a narrow column:** the PM chat. It is the same thread as the top
  bar's, so anything said here is there too.
- **Bottom of the right column:** the note box. Enter sends, Shift+Enter is a
  new line. A pending screenshot shows as a chip above it, removable.
- **Top bar, left:** Stop, Screenshot, Restart (glows when newer work has
  merged), the commit being played, the time left.
- **Top bar, right:** **Sessions** (past playtests and their notes), Open in
  new tab, Close.
- **Phone:** the product fills the screen; the chat is a sheet pulled up from
  the bottom. Screenshot hides when the in-frame helper is not attached (see
  below), since phones have no screen-capture fallback.

### Starting

A progress line while the sandbox comes up, with the ants digging:
opening a sandbox → cloning → installing → starting → live. On failure: the
last log lines and **Ask an agent to fix it**, which proposes a Backlog item
with the log in it.

### Notes and the PM

- A note is an assistant message tagged with the session
  (`AssistantMessage.playtestId`) and the commit. It shows a small "Playtest"
  chip in the top bar's chat too.
- **Notes wait for a pause.** The PM answers once you've stopped typing for a
  few seconds, all the waiting notes together, not one reply per note.
- The PM's prompt for a playtest note: judge it against the epics' PRDs, the
  tickets and the code. Say one of:
  - **Intended**, with the line that says so.
  - **Already known**, linking the card or pull request.
  - **Worth a ticket**: propose `create_backlog_item` with the note, and the
    screenshots attached. Never fix code from a playtest note.
- **Screenshots:** the same as images in the PM chat (#1490). Each uploads
  under its own `playtest-…` request id, and the note claims it through
  `Attachment.assistantMessageId`, so the PM sees the picture itself (the
  latest three notes with images; older ones as a line naming the file). A
  note only claims this board's own uploads. An approved `create_backlog_item`
  copies the named screenshots onto the new Epic, so the Product and Coder
  agents see them too, and the note keeps its own.
- **Nudges, no tokens spent:** plain PM lines written by the server.
  - "5 minutes left in this playtest."
  - "T-42 just merged. Restart to play it." (when the default branch moves past
    the session's commit)
- **On Stop:** a summary line: "3 notes, 1 ticket proposed, 2 intended."

### Sessions

Every playtest is saved: `PlaytestSession` (who, which commit, when, how it
ended, the summary). **Sessions** in the top right lists them, newest first;
opening one shows its notes, screenshots and the PM's answers, read-only.
The notes are ordinary PM messages, so the PM keeps them in its history after
the session closes, and a `playtest_sessions` read lets it look further back.

## How a session runs

1. `POST /api/playtest` checks the rules below, writes a `PlaytestSession`
   (`starting`), and starts the sandbox in the background. Functions have no
   time limit on the production server (AGENTS.md).
2. In an E2B sandbox, on the person's own key:
   - clone the default branch with their token, then rewrite the remote to
     the bare URL so no project code can read the token;
   - run the toolchain setup (`src/lib/toolchains`, `setupScript("sandbox")`);
   - detect how to start it (below) and start it in the background;
   - start the **playtest proxy** on port 4173 in front of it and wait for the
     app to answer;
   - `getHost(4173)` gives the public URL. Session → `live`.
3. The browser polls `GET /api/playtest/[id]` for its stage, log tail and
   messages. The poll is the heartbeat, and where the time warning and the
   "newer work merged" line are written (`tick` in `src/lib/playtest/service.ts`).
4. Stop, the 20-minute limit, or a closed tab (90 seconds after the board
   stops polling) kills the sandbox. Closing the Playtest screen alone does
   not: the board keeps the session alive, and the Done button shows its time
   left and reopens it. Session → `ended`.

### What it can start (`src/lib/playtest/detect.ts`)

In order, first match wins:

1. `.github/formic/playtest.sh`: run as is. It must serve on `$PORT`.
2. Godot (`project.godot`): install export templates for the engine version,
   `godot --headless --export-release Web build/web/index.html` with a Web
   preset written if none exists (single-threaded, so no COOP/COEP needed),
   then serve `build/web` statically.
3. Node (`package.json`): `npm ci` (or the lockfile's manager), then the
   `dev` script, else `start`, with `PORT` and `HOST=0.0.0.0` set.
4. A root `index.html`: served statically.
5. Otherwise: "Playtest runs web apps and Godot games for now. Add
   `.github/formic/playtest.sh` to tell it how to start yours."

### The playtest proxy (`src/lib/playtest/proxy-script.ts`)

A small Node server written into the sandbox: it forwards every request (and
WebSocket upgrade, for dev-server reload) to the app, and adds one script tag
to HTML responses. That script, in the app's own page:

- answers `postMessage` capture requests from Formic with a PNG of the
  requested region (a `<canvas>` via `toDataURL` when one covers it;
  otherwise the page via `html-to-image`, which the sandbox fetches from the
  npm registry and the proxy serves on the product's own origin);
- forces `preserveDrawingBuffer` on WebGL contexts, so a Godot canvas is not
  blank when read between frames.

It only answers messages from the Formic origin it was given. If the helper
never says hello, desktop falls back to `getDisplayMedia` (the browser asks),
and phones hide Screenshot.

### Drag to select

Screenshot puts a clear layer over the frame; drag (mouse or finger) draws the
rectangle, Escape cancels. The region goes to the helper, the PNG comes back,
is uploaded, and joins the note being written (or starts one).

## Rules (from the risk assessment)

- **Own E2B key only.** With accounts, the clicker's own key, never the
  owner's shared one (`shareKeys`) and never the server's `E2B_API_KEY`. In
  local mode, the server's key is the person's own.
- **Must be able to read the repository** with their own GitHub or GitLab
  token. The button explains if not.
- **Something must have merged**: the Done column has at least one ticket.
- **No credentials in the sandbox.** Token stripped from `.git/config` before
  any project code runs; no AI keys, no Formic environment.
- **Public URL warning** beside Open in new tab: "Anyone with this link can
  open it while it runs."
- **One session per person**, across boards. Starting another stops the old.
- **Hard limits:** 20 minutes per session, 5 minutes to start.
- **Never the local sandbox**: Playtest always uses E2B.

## Data

```prisma
model PlaytestSession {
  id         String    @id @default(cuid())
  projectId  String
  userId     String
  commitSha  String?
  sandboxId  String?
  url        String?
  /// starting | live | failed | ended
  status     String    @default("starting")
  stage      String?
  logTail    String?
  error      String?
  summary    String?
  heartbeat  DateTime  @default(now())
  startedAt  DateTime  @default(now())
  endsAt     DateTime
  endedAt    DateTime?
}
// AssistantMessage gains: playtestId String?
// Screenshots use Attachment.assistantMessageId, from the PM chat's images.
```

## Steps

- [x] 1. This plan.
- [x] 2. Unlock and onboarding: `playtest` at Lv 15, reveal, `playtest-intro`
      tour, the Done-column button and its states.
- [x] 3. Data: `PlaytestSession`, the `AssistantMessage` columns, repository
      methods (Prisma and memory), migration.
- [x] 4. Sandbox: detection, the proxy and capture helper, the E2B session
      runner (background start, `getHost`, token strip, limits, reaper).
- [x] 5. API: start, status, heartbeat, stop, sessions list.
- [x] 6. Playtest screen: frame, stages, top bar, Open in new tab warning.
- [x] 7. Chat column: notes tagged to the session, batching, PM prompt,
      nudges, end-of-session summary, screenshot attachments on proposals.
- [x] 8. Screenshot: drag to select, helper capture, upload, fallback.
- [x] 9. Sessions: list and read-only view; the PM's `playtest_sessions` read.
- [x] 10. Tests, docs (`docs/how-it-works.md`, README feature list).
