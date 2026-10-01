/**
 * The workflow Formic installs in a repository to run CLI agents there.
 *
 * Claude Code, Codex and Gemini CLI run in the repository's own GitHub
 * Actions, signed in with the person's own plan. The workflow checks out the
 * branch, runs the agent, commits what it changed and pushes it to a
 * formic-staging/ branch. Nothing reaches a real branch from here: Formic
 * reads the staging branch, checks it against the ticket's file scope, and
 * only then moves the real branch with the owner's token (which is also what
 * makes CI run on it; pushes made with the workflow's own token do not).
 *
 * The planning columns run here too. There the agent reads the repository
 * and answers instead of changing it: its answer is committed alone to the
 * staging branch as ANSWER_PATH, whatever else it touched is thrown away,
 * and Formic checks the answer as it would any other agent's.
 *
 * No server imports: the webhook parser reads the names below too.
 */

import { createHash } from "node:crypto";

export const RUNNER_WORKFLOW_FILE = "formic-agent.yml";
export const RUNNER_WORKFLOW_PATH = `.github/workflows/${RUNNER_WORKFLOW_FILE}`;
export const RUNNER_WORKFLOW_NAME = "Formic agent";
/** Every version's setup branch starts with this; see RUNNER_SETUP_BRANCH. */
export const RUNNER_SETUP_PREFIX = "formic/setup-runner-";

/** Where a planning agent's answer sits on its staging branch. */
export const ANSWER_PATH = ".formic/answer.md";

/**
 * How long a job may run: GitHub's own maximum is 360, and this is what Formic
 * writes into every repository's workflow. It is the backstop, not the plan —
 * the plan is the ticket's budget, which a run is clamped to when it is
 * over this less the headroom (see `loopBudgetMs` in ./runner), because a run that hits its own limit stops and
 * says which limit it was, and a job the platform kills says nothing.
 */
export const RUNNER_JOB_MINUTES = 60;

/** What a workflow installed before the `timeout` input holds a job to. */
export const LEGACY_JOB_MINUTES = 180;

/**
 * The most a repository's installed workflow lets a job run, and whether it
 * takes the run's own timeout as an input. A workflow without the input keeps
 * its fixed ceiling and is dispatched without one.
 */
export function workflowCeiling(workflow: string | null): { minutes: number; takesTimeout: boolean } {
  return workflow?.includes("inputs.timeout")
    ? { minutes: RUNNER_JOB_MINUTES, takesTimeout: true }
    : { minutes: LEGACY_JOB_MINUTES, takesTimeout: false };
}

/** What the budget leaves a loop run for cloning, installing and reporting. */
export const JOB_HEADROOM_MINUTES = 5;

/**
 * The environment variable that names the directory a job's downloaded
 * attachments live in: a CLI agent with no Formic session fetches them with
 * curl from the signed URLs in its prompt (see attachmentsPrompt in
 * ./runner) and reads them from here, but never commits it.
 */
export const ATTACHMENTS_DIR_VAR = "FORMIC_ATTACHMENTS";

/**
 * GitHub refuses any push from the workflow's own token that changes a file
 * under .github/workflows. So an agent's changes there travel on the staging
 * branch under CARRY_DIR (at the same path below it), with the workflow files
 * it deleted listed in CARRY_DELETED, and Formic puts them back in place with
 * the owner's token when it takes the work.
 */
export const CARRY_DIR = ".formic/carry";
export const CARRY_DELETED = ".formic/carry-deleted";

/** Whether a path is part of how workflow changes are carried, not a change itself. */
export function isCarried(path: string): boolean {
  return path === CARRY_DELETED || path.startsWith(`${CARRY_DIR}/`);
}

/**
 * The last line of a run's commit when it merged another branch in first,
 * followed by the commit it merged. Formic records that merge itself.
 */
export const MERGED_TRAILER = "Formic-Merged:";

/**
 * The last line of a run's summary when it reports what it used, followed by
 * its usage as JSON. The loop entry writes it; the runner reads it back, so a
 * run on a metered key spends money that gets counted.
 */
export const USAGE_TRAILER = "Formic-Usage:";

/**
 * The trailer that marks a run's report that the ticket was already done.
 * The workflow only hands work back when there is a commit, so an agent makes
 * an empty one; that keeps the installed workflow unchanged. It lives here,
 * next to the other trailers, because the workflow's own script writes it.
 */
export const ALREADY_DONE_TRAILER = "Formic-Already-Done: true";

/**
 * The last line of a checkpoint commit, followed by the job that saved it.
 * A run that starts on one carries on from it: the workflow steps back to
 * where that work started and leaves the work in the checkout, uncommitted,
 * with the checkpoint's notes as the new run's progress file.
 */
export const CHECKPOINT_TRAILER = "Formic-Checkpoint:";

export const CODE_MODES = ["implement", "fix"] as const;
export const ANSWER_MODES = ["product", "architect", "showcase"] as const;
export type CodeMode = (typeof CODE_MODES)[number];
export type AnswerMode = (typeof ANSWER_MODES)[number];
/** The board's assistant answering a question. */
export type AskMode = "ask";
/**
 * Formic's own loop running in the job: an agent on an API key, working where
 * a CLI agent works instead of in a serverless window. The job fetches the
 * bundle (`/api/runner/bundle`) and runs it; see docs/long-runs.md.
 */
export type LoopMode = "loop";
export type RunnerMode = CodeMode | AnswerMode | AskMode | LoopMode;

export function isAnswerMode(mode: RunnerMode): mode is AnswerMode {
  return (ANSWER_MODES as readonly string[]).includes(mode);
}

/**
 * A run doing a ticket's work from the start: `implement`, and `loop`, which
 * is the same work run in a job on an API key. `fix` is not one of these — it
 * builds on a pull request that is already open — and neither is an answer.
 */
export function isTicketImplementation(mode: RunnerMode): boolean {
  return mode === "implement" || mode === "loop";
}

/**
 * The run's title, which is how its completion finds its way back: GitHub
 * sends it as `display_title` on the workflow_run webhook.
 */
export function runTitle(mode: RunnerMode, ticketKey: string, job: string): string {
  return `Formic ${mode} ${ticketKey} · ${job}`;
}

export function parseRunTitle(
  title: string,
): { mode: RunnerMode; ticketKey: string; job: string } | null {
  const m = /^Formic (implement|fix|loop|product|architect|showcase|ask) (\S+) · (\S+)$/.exec(title.trim());
  return m ? { mode: m[1] as RunnerMode, ticketKey: m[2]!, job: m[3]! } : null;
}

/**
 * What makes a finished run's result taken once: the webhook and the
 * collector that looks it up on GitHub both claim this before acting.
 */
export function runnerResultKey(job: string, runId: number | string): string {
  return `runner:${job}:${String(runId)}`;
}

/**
 * A job id is `<card id>--<nonce>`, plus `-<attempt>` from the second
 * attempt on: safe in a branch name and a title. The card is a ticket for
 * the coding modes and an epic for the planning ones.
 */
export function jobId(cardId: string, nonce: string, attempt = 1): string {
  return `${cardId}--${nonce}${attempt > 1 ? `-${attempt}` : ""}`;
}

export function cardOfJob(job: string): string | null {
  const i = job.lastIndexOf("--");
  return i > 0 ? job.slice(0, i) : null;
}

export function attemptOfJob(job: string): number {
  const m = /--[^-]+-(\d+)$/.exec(job);
  return m ? Number(m[1]) : 1;
}

/**
 * Runs beside the agent: every few seconds, posts what it printed since the
 * last time to Formic, and writes any notes Formic answers with to the file
 * the agent's hook reads. A report that fails is sent again with the next;
 * one that keeps failing never fails the run.
 *
 * On a coding run it also sends a checkpoint whenever the checkout or the
 * agent's progress file has changed, at most every CHECKPOINT_EVERY seconds
 * and once more at the end: every file that differs from where the run
 * started, whole. A run can stop at any moment, and the next one carries on
 * from the last checkpoint. It stages into an index of its own, so the
 * agent's git state is never touched. A checkpoint too big to post is
 * skipped rather than sent in part.
 */
export const REPORTER_SCRIPT = String.raw`import base64, hashlib, json, os, subprocess, time, urllib.request

url = os.environ["REPORT"]
stream = os.environ["FORMIC_STREAM"]
notes = os.environ["FORMIC_NOTES"]
done = os.environ["FORMIC_DONE"]
progress = os.environ.get("FORMIC_PROGRESS", "")
start = os.environ.get("FORMIC_START", "")
checkpointing = bool(os.environ.get("FORMIC_CHECKPOINT")) and bool(start)
index = os.path.join(os.environ.get("RUNNER_TEMP", "/tmp"), "formic-checkpoint-index")
CHECKPOINT_EVERY = 30
MAX_CHECKPOINT = 2500000
sent = 0
after = 0
stopped = False
saved = None
saved_at = 0.0


def post(lines, checkpoint=None):
    global after, stopped
    payload = {"lines": lines, "after": after}
    if checkpoint:
        payload["checkpoint"] = checkpoint
    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, method="POST", headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as res:
        reply = json.load(res)
    for note in reply.get("notes", []):
        with open(notes, "a") as f:
            f.write("A note from the person watching this ticket on Formic. Take it into account from here on:\n" + note["text"] + "\n\n")
        after = max(after, int(note["seq"]))
    stopped = bool(reply.get("stop"))
    return reply


def flush():
    global sent
    try:
        with open(stream, "rb") as f:
            f.seek(sent)
            chunk = f.read()
    except OSError:
        return
    lines = chunk[: chunk.rfind(b"\n") + 1].split(b"\n")[:-1]
    if not lines:
        post([])
        return
    for i in range(0, len(lines), 500):
        batch = lines[i : i + 500]
        post([line.decode("utf-8", "replace") for line in batch])
        sent += sum(len(line) + 1 for line in batch)


def git(*args):
    env = dict(os.environ, GIT_INDEX_FILE=index)
    return subprocess.run(["git", *args], env=env, check=True, capture_output=True).stdout


def progress_note():
    try:
        with open(progress, encoding="utf-8", errors="replace") as f:
            return f.read()[-20000:]
    except OSError:
        return ""


def checkpoint(final):
    global saved, saved_at
    if not checkpointing or (not final and time.time() - saved_at < CHECKPOINT_EVERY):
        return
    git("add", "-A")
    tree = git("write-tree").decode().strip()
    note = progress_note()
    key = tree + hashlib.sha256(note.encode()).hexdigest()
    if key == saved:
        return
    files, deleted, size = [], [], 0
    parts = git("diff-tree", "-r", "-z", "--no-renames", start, tree).split(b"\0")
    for meta, path in zip(parts[0::2], parts[1::2]):
        _, mode, _, sha, status = meta.decode().lstrip(":").split(" ")
        name = path.decode("utf-8", "replace")
        if status == "D":
            deleted.append(name)
        elif mode != "160000":
            data = git("cat-file", "blob", sha)
            size += len(data)
            files.append({"path": name, "mode": mode, "content": base64.b64encode(data).decode()})
    saved_at = time.time()
    if size > MAX_CHECKPOINT or post([], {"base": start, "files": files, "deleted": deleted, "note": note}).get("checkpointed"):
        saved = key


if checkpointing:
    try:
        git("read-tree", start)
        saved = git("rev-parse", start + "^{tree}").decode().strip() + hashlib.sha256(b"").hexdigest()
    except Exception:
        checkpointing = False

while not stopped:
    last = os.path.exists(done)
    try:
        flush()
    except Exception:
        pass
    try:
        checkpoint(last)
    except Exception:
        pass
    if last:
        break
    time.sleep(4)
`;

/**
 * Claude Code's hook that hands it a note between its steps: after each
 * tool, if a note has come in, it is shown to the agent (exit code 2 makes
 * Claude Code read what the hook printed) and taken off the pile.
 */
export const NOTES_HOOK = JSON.stringify({
  hooks: {
    PostToolUse: [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command:
              'f="$FORMIC_NOTES"; if [ -s "$f" ] && mv "$f" "$f.taking" 2>/dev/null; then cat "$f.taking" >&2; rm -f "$f.taking"; exit 2; fi; exit 0',
          },
        ],
      },
    ],
  },
});

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line ? pad + line : line))
    .join("\n");
}

/**
 * The workflow itself. Inputs reach the shell through `env:` only, never
 * through `${{ }}` inside a script: the prompt is ticket text, and ticket
 * text spliced into bash is a script injection. Each agent gets only its own
 * secret: each saved agent has one of its own, named by the `secret` input,
 * so two accounts on the same CLI never overwrite each other mid-run. Only
 * that CLI's FORMIC_ secrets can be named, never the repository's others.
 */
export function runnerWorkflow(): string {
  return `# ${RUNNER_VERSION}\n${workflowBody()}`;
}

function workflowBody(): string {
  return `# Installed by Formic (https://formic-board.vercel.app). Runs a coding agent
# on your own plan when a Formic card asks for one, and pushes its work to a
# formic-staging/ branch for Formic to check. Formic replaces this file when
# its version changes.
name: ${RUNNER_WORKFLOW_NAME}
run-name: "Formic \${{ inputs.mode }} \${{ inputs.ticket }} · \${{ inputs.job }}"

on:
  workflow_dispatch:
    inputs:
      job:
        description: Formic job id
        required: true
      mode:
        description: implement, fix, loop, product, architect, showcase or ask
        required: true
      ticket:
        description: Ticket key
        required: true
      cli:
        description: claude, codex or gemini
        required: true
      model:
        description: Model, or empty for the agent's default
        required: false
        default: ""
      from:
        description: Branch to start from
        required: true
      secret:
        description: The Actions secret holding this agent's sign-in
        required: true
      prompt:
        description: What to do
        required: true
      bundle:
        description: Where to fetch Formic's loop entry from (mode loop), or empty
        required: false
        default: ""
      report:
        description: Where to post what the agent does as it works, or empty
        required: false
        default: ""
      merge:
        description: A branch to merge in first, its conflicts left for the agent, or empty
        required: false
        default: ""
      timeout:
        description: Minutes the job may run, at most ${RUNNER_JOB_MINUTES}
        required: false
        default: "${RUNNER_JOB_MINUTES}"

permissions:
  contents: write

concurrency:
  group: formic-\${{ inputs.job }}

jobs:
  agent:
    runs-on: ubuntu-latest
    timeout-minutes: \${{ fromJSON(inputs.timeout) }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ inputs.from }}
          persist-credentials: false
          # Merging needs the history both sides share; a checkpoint, the
          # commit it was saved on.
          fetch-depth: \${{ inputs.merge != '' && '0' || '2' }}

      # Started on a checkpoint (Formic names one by its commit, never by a
      # branch): carry on from it, its work uncommitted in the checkout and
      # its notes in the progress file, as it was left.
      - name: Remember where the agent started
        env:
          FROM: \${{ inputs.from }}
        run: |
          if [[ "$FROM" =~ ^[0-9a-f]{40}$ ]] && git log -1 --format=%B | grep -q '^${CHECKPOINT_TRAILER}'; then
            git log -1 --format=%b | grep -v '^${CHECKPOINT_TRAILER}' > "$RUNNER_TEMP/formic-progress.md" || true
            git reset -q HEAD~1
            echo "Carrying on from the checkpoint of a run that stopped."
          fi
          echo "FORMIC_START=$(git rev-parse HEAD)" >> "$GITHUB_ENV"

      # Conflicts and all: resolving them is the agent's work.
      - name: Bring the other branch in
        if: inputs.merge != ''
        env:
          MERGE: \${{ inputs.merge }}
        run: |
          merged="$(git rev-parse "origin/$MERGE")"
          if ! git -c user.name="Formic Agent" -c user.email=formic-agent@users.noreply.github.com merge --no-commit --no-ff "$merged"; then
            if [ -z "$(git diff --name-only --diff-filter=U)" ]; then echo "Could not merge $MERGE."; exit 1; fi
          fi
          echo "FORMIC_MERGED=$merged" >> "$GITHUB_ENV"

      # Only matters when the job actually has attachments; harmless
      # otherwise, and nothing later in the job depends on it.
      - name: Make room for downloaded attachments
        run: mkdir -p "$RUNNER_TEMP/formic-attachments"

      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 22

      # Every run is a fresh machine. The package caches carry the agent's
      # own install and the project's dependencies from one run to the next,
      # so neither is downloaded from scratch each time.
      - uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
        with:
          path: |
            ~/.npm
            ~/.cache/pip
            ~/.cache/yarn
            ~/.local/share/pnpm/store
          key: formic-\${{ runner.os }}-\${{ hashFiles('**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/requirements*.txt') }}
          restore-keys: formic-\${{ runner.os }}-

      - name: Install the agent
        if: inputs.mode != 'loop'
        env:
          CLI: \${{ inputs.cli }}
        run: |
          case "$CLI" in
            claude) npm install -g @anthropic-ai/claude-code ;;
            codex) npm install -g @openai/codex ;;
            gemini) npm install -g @google/gemini-cli ;;
            *) echo "Unknown agent: $CLI"; exit 1 ;;
          esac

      # Ready before the agent starts, so it spends its turns on the ticket.
      # Only the coding modes need them, and a failure here is not fatal:
      # the agent can still install what it needs itself.
      - name: Install the project's dependencies
        if: inputs.mode == 'implement' || inputs.mode == 'fix' || inputs.mode == 'loop'
        continue-on-error: true
        run: |
          # Installed, never handed back: kept out of what the agent commits.
          echo "node_modules/" >> .git/info/exclude
          if [ -f package-lock.json ]; then npm ci --prefer-offline --no-audit --fund=false
          elif [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile
          elif [ -f yarn.lock ]; then corepack enable && yarn install
          elif [ -f requirements.txt ]; then pip install -r requirements.txt
          fi

      - name: Run the agent
        env:
          CLI: \${{ inputs.cli }}
          MODE: \${{ inputs.mode }}
          # The card's own key, for the summary a loop run writes.
          TICKET: \${{ inputs.ticket }}
          BUNDLE: \${{ inputs.bundle }}
          MODEL: \${{ inputs.model }}
          PROMPT: \${{ inputs.prompt }}
          REPORT: \${{ inputs.report }}
          FORMIC_REPORT: \${{ runner.temp }}/formic-report.json
          # The loop's key comes from the repository's Actions secrets, like a
          # CLI agent's sign-in: never from an input, which the run's event
          # keeps for anyone who can read it.
          FORMIC_API_KEY: \${{ inputs.mode == 'loop' && startsWith(inputs.secret, 'FORMIC_API_KEY_') && secrets[inputs.secret] || '' }}
          FORMIC_SUMMARY: \${{ runner.temp }}/formic-summary.md
          FORMIC_OUTPUT: \${{ runner.temp }}/formic-answer.md
          FORMIC_STDOUT: \${{ runner.temp }}/formic-stdout.md
          FORMIC_STREAM: \${{ runner.temp }}/formic-stream.jsonl
          FORMIC_NOTES: \${{ runner.temp }}/formic-notes.md
          FORMIC_DONE: \${{ runner.temp }}/formic-done
          FORMIC_PROGRESS: \${{ runner.temp }}/formic-progress.md
          # Coding runs save checkpoints; a run resolving merge conflicts is
          # short, and its merge could not be carried on from one.
          FORMIC_CHECKPOINT: \${{ (inputs.mode == 'implement' || inputs.mode == 'fix' || inputs.mode == 'loop') && inputs.merge == '' && 'on' || '' }}
          # Claude Code turns its todo tool off when run with -p; the ticket's
          # plan and progress bar are read from it.
          CLAUDE_CODE_ENABLE_TODO_TOOLS: "true"
          CLAUDE_CODE_ENABLE_TASKS: "false"
          ${ATTACHMENTS_DIR_VAR}: \${{ runner.temp }}/formic-attachments
          CLAUDE_CODE_OAUTH_TOKEN: \${{ inputs.cli == 'claude' && startsWith(inputs.secret, 'FORMIC_CLAUDE_CODE_TOKEN') && secrets[inputs.secret] || '' }}
          CODEX_CREDENTIAL: \${{ inputs.cli == 'codex' && startsWith(inputs.secret, 'FORMIC_CODEX_AUTH') && secrets[inputs.secret] || '' }}
          GEMINI_API_KEY: \${{ inputs.cli == 'gemini' && startsWith(inputs.secret, 'FORMIC_GEMINI_API_KEY') && secrets[inputs.secret] || '' }}
        run: |
          set -euo pipefail
          : > "$FORMIC_STREAM"
          # What the agent does, posted to Formic as it works.
          if [ -n "$REPORT" ]; then
            cat > "$RUNNER_TEMP/formic-report.py" <<'FORMIC_REPORTER'
${indent(REPORTER_SCRIPT, 10)}
          FORMIC_REPORTER
            python3 "$RUNNER_TEMP/formic-report.py" &
            reporter=$!
            trap 'touch "$FORMIC_DONE"; wait "$reporter" || true' EXIT
          fi
          case "$MODE" in
            loop)
              # Formic's own loop, fetched as one file: an agent on an API key
              # working here, where a CLI agent works, until its budget says
              # stop. It writes its progress to stderr as one JSON event per
              # line, which the reporter above posts as it goes.
              if [ -z "$BUNDLE" ]; then echo "This loop run came with no bundle URL."; exit 1; fi
              if [ -z "$FORMIC_API_KEY" ]; then echo "No API key for this agent. Add it to the agent in Formic."; exit 1; fi
              payload="$RUNNER_TEMP/formic-payload.json"
              jq --arg key "$FORMIC_API_KEY" --arg dir "$PWD" '.apiKey = $key | .repo.dir = $dir' <<< "$PROMPT" > "$payload"
              curl -fsSL --max-time 60 --retry 2 -o "$RUNNER_TEMP/formic-loop.mjs" "$BUNDLE"
              set +e
              # Its account of the run goes to Formic through the reporter, and
              # to this log as well: a step that shows nothing cannot be told
              # apart from one that is stuck. tee writes the stream, and the
              # pipeline is waited on, so every line is flushed before the step
              # moves on; the loop's own exit code is PIPESTATUS[0].
              node "$RUNNER_TEMP/formic-loop.mjs" < "$payload" \
                2>&1 > "$FORMIC_REPORT" | tee -a "$FORMIC_STREAM"
              status=\${PIPESTATUS[0]}
              set -e
              rm -f "$payload" "$RUNNER_TEMP/formic-loop.mjs"
              if [ "$status" -ne 0 ]; then
                if [ -s "$FORMIC_REPORT" ]; then jq -r '.error // empty' "$FORMIC_REPORT" >&2 || true; fi
                echo "The loop stopped (exit $status)."
                exit "$status"
              fi
              # Its report becomes the commit's message: what it changed, what
              # it hands to the person, and what it used.
              {
                printf '%s: %s\\n\\n' "$TICKET" "$(jq -r '.summary' "$FORMIC_REPORT")"
                jq -r '.detail' "$FORMIC_REPORT"
                if [ "$(jq -r '.handoff | length' "$FORMIC_REPORT")" -gt 0 ]; then
                  printf '\\nFor you:\\n'
                  jq -r '.handoff[] | "- " + .' "$FORMIC_REPORT"
                fi
                printf '\\n${USAGE_TRAILER} %s\\n' "$(jq -c '.usage | {model, tokensIn, tokensOut, costCents}' "$FORMIC_REPORT")"
              } > "$FORMIC_SUMMARY"
              if [ "$(jq -r '.alreadyDone' "$FORMIC_REPORT")" = "true" ]; then
                printf '${ALREADY_DONE_TRAILER}\\n' >> "$FORMIC_SUMMARY"
                # Nothing to change: an empty commit, so the step below hands
                # back a report instead of calling it a run that failed.
                if git diff --quiet && git diff --cached --quiet; then
                  git -c user.name="Formic Agent" -c user.email=formic-agent@users.noreply.github.com commit -q --allow-empty -m "$TICKET: nothing to change"
                fi
              fi
              ;;
          esac
          case "$CLI" in
            claude)
              if [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ]; then echo "No Claude Code token. Add it to the agent in Formic."; exit 1; fi
              printf '%s' '${NOTES_HOOK}' > "$RUNNER_TEMP/formic-hooks.json"
              args=(-p "$PROMPT" --output-format stream-json --verbose --settings "$RUNNER_TEMP/formic-hooks.json" --dangerously-skip-permissions)
              if [ -n "$MODEL" ]; then args+=(--model "$MODEL"); fi
              claude "\${args[@]}" | tee -a "$FORMIC_STREAM"
              jq -Rrj 'fromjson? | select(.type == "result") | (.result // empty)' "$FORMIC_STREAM" > "$FORMIC_STDOUT"
              ;;
            codex)
              if [ -z "$CODEX_CREDENTIAL" ]; then echo "No Codex sign-in. Add it to the agent in Formic."; exit 1; fi
              if [[ "$CODEX_CREDENTIAL" == \\{* ]]; then
                mkdir -p ~/.codex
                printf '%s' "$CODEX_CREDENTIAL" > ~/.codex/auth.json
              else
                export CODEX_API_KEY="$CODEX_CREDENTIAL" OPENAI_API_KEY="$CODEX_CREDENTIAL"
              fi
              unset CODEX_CREDENTIAL
              args=(exec --json --output-last-message "$FORMIC_STDOUT" --dangerously-bypass-approvals-and-sandbox)
              if [ -n "$MODEL" ]; then args+=(-m "$MODEL"); fi
              codex "\${args[@]}" "$PROMPT" | tee -a "$FORMIC_STREAM"
              ;;
            gemini)
              if [ -z "$GEMINI_API_KEY" ]; then echo "No Gemini API key. Add it to the agent in Formic."; exit 1; fi
              # Reads the repository's AGENTS.md as well as its own GEMINI.md.
              mkdir -p ~/.gemini
              printf '%s' '{"context":{"fileName":["AGENTS.md","GEMINI.md"]}}' > ~/.gemini/settings.json
              args=(-p "$PROMPT" --output-format stream-json --approval-mode yolo)
              if [ -n "$MODEL" ]; then args+=(-m "$MODEL"); fi
              gemini "\${args[@]}" | tee -a "$FORMIC_STREAM"
              jq -Rrj 'fromjson? | select(.type == "message" and .role == "assistant") | (.content // empty)' "$FORMIC_STREAM" > "$FORMIC_STDOUT"
              ;;
          esac

      - name: Hand the work to Formic
        env:
          JOB: \${{ inputs.job }}
          MODE: \${{ inputs.mode }}
          TICKET: \${{ inputs.ticket }}
          FORMIC_SUMMARY: \${{ runner.temp }}/formic-summary.md
          FORMIC_OUTPUT: \${{ runner.temp }}/formic-answer.md
          FORMIC_STDOUT: \${{ runner.temp }}/formic-stdout.md
          FORMIC_STREAM: \${{ runner.temp }}/formic-stream.jsonl
          CLI: \${{ inputs.cli }}
          MODEL: \${{ inputs.model }}
          GH_TOKEN: \${{ github.token }}
          REPO: \${{ github.repository }}
        run: |
          set -euo pipefail
          git config user.name "Formic Agent"
          git config user.email "formic-agent@users.noreply.github.com"
          case "$MODE" in
            product|architect|showcase|ask)
              # An answer, not a change: only the answer leaves this run.
              git reset -q --hard "$FORMIC_START"
              git clean -qfdx
              answer="$FORMIC_OUTPUT"
              if [ ! -s "$answer" ]; then answer="$FORMIC_STDOUT"; fi
              if [ ! -s "$answer" ]; then echo "The agent finished without an answer."; exit 1; fi
              mkdir -p "$(dirname "${ANSWER_PATH}")"
              cp "$answer" "${ANSWER_PATH}"
              git add -f "${ANSWER_PATH}"
              git commit -q -m "$TICKET: $MODE answer"
              git push "https://x-access-token:\${GH_TOKEN}@github.com/\${REPO}.git" "HEAD:refs/heads/formic-staging/\${JOB}"
              exit 0
              ;;
          esac
          if [ -n "\${FORMIC_MERGED:-}" ]; then
            git add -A
            if git diff --cached "$FORMIC_START" | grep -qE '^\\+(<<<<<<<|>>>>>>>)( |$)'; then
              echo "Conflict markers are still in the change."
              exit 1
            fi
            # One plain commit on the branch for now. Formic makes it the
            # merge, with the owner's token, once it has checked it.
            rm -f .git/MERGE_HEAD .git/MERGE_MSG .git/MERGE_MODE .git/AUTO_MERGE
            git reset -q --soft "$FORMIC_START"
          fi
          git add -A
          if git diff --cached --quiet && [ "$(git rev-parse HEAD)" = "$FORMIC_START" ]; then
            echo "The agent finished without changing anything."
            exit 1
          fi
          # This token may not push workflow changes: carry them for Formic.
          if [ -n "$(git diff --cached --name-only "$FORMIC_START" -- .github/workflows)" ]; then
            git reset -q --soft "$FORMIC_START"
            mkdir -p "${CARRY_DIR}"
            git diff --cached --no-renames --name-only --diff-filter=d -- .github/workflows | while IFS= read -r f; do
              mkdir -p "$(dirname "${CARRY_DIR}/$f")"
              git show ":$f" > "${CARRY_DIR}/$f"
            done
            git diff --cached --no-renames --name-only --diff-filter=D -- .github/workflows > "${CARRY_DELETED}"
            git reset -q "$FORMIC_START" -- .github/workflows
            git add -f "${CARRY_DIR}" "${CARRY_DELETED}"
          fi
          # No summary written: the agent's last words are the next best thing.
          if [ ! -s "$FORMIC_SUMMARY" ] && [ -s "$FORMIC_STDOUT" ]; then
            { printf '%s: %s\\n\\n' "$TICKET" "$(head -n 1 "$FORMIC_STDOUT" | cut -c 1-70)"; tail -n +2 "$FORMIC_STDOUT"; } > "$FORMIC_SUMMARY"
          fi
          if [ ! -s "$FORMIC_SUMMARY" ]; then
            printf '%s: changes from the agent\\n' "$TICKET" > "$FORMIC_SUMMARY"
          fi
          # A CLI agent reports tokens only, from its stream: claude and gemini
          # on their result event, codex on each turn that completed. The loop
          # wrote its own trailer.
          if ! grep -q '^${USAGE_TRAILER}' "$FORMIC_SUMMARY" && [ -s "$FORMIC_STREAM" ]; then
            usage="$(jq -Rn '
              [inputs | fromjson? | objects
                | if .type == "result" then (.usage // .stats)
                  elif .type == "turn.completed" then .usage
                  else null end
                | select(. != null)]
              | if length == 0 then empty else {
                  model: ((env.MODEL | select(. != "")) // env.CLI),
                  tokensIn: (map((.input_tokens // 0) + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0)) | add),
                  tokensOut: (map(.output_tokens // 0) | add),
                  costCents: 0
                } end' "$FORMIC_STREAM" || true)"
            if [ -n "$usage" ]; then
              printf '\\n${USAGE_TRAILER} %s\\n' "$(jq -c . <<< "$usage")" >> "$FORMIC_SUMMARY"
            fi
          fi
          if [ -n "\${FORMIC_MERGED:-}" ]; then
            printf '\\n${MERGED_TRAILER} %s\\n' "$FORMIC_MERGED" >> "$FORMIC_SUMMARY"
          fi
          git commit --allow-empty -F "$FORMIC_SUMMARY"
          git push "https://x-access-token:\${GH_TOKEN}@github.com/\${REPO}.git" "HEAD:refs/heads/formic-staging/\${JOB}"
`;
}

/**
 * Which workflow a repository has, so old copies get replaced. Worked out
 * from the workflow's own text rather than bumped by hand: two changes made
 * at once can never land on the same version, and there is no constant for
 * them to conflict over. The checked-in copy under .github/workflows is
 * Formic's own install, refreshed by its setup pull request like any other
 * repository's: never edit it by hand. Last in the file: it reads the whole
 * workflow, which reads everything above.
 */
const RUNNER_HASH = createHash("sha256").update(workflowBody()).digest("hex").slice(0, 12);
export const RUNNER_VERSION = `formic-runner: ${RUNNER_HASH}`;

/**
 * Where the setup pull request comes from: a branch of its own per version,
 * cut from the base branch as it is now. Reusing one branch left each new
 * setup pull request on top of an old base, where it conflicted.
 */
export const RUNNER_SETUP_BRANCH = `${RUNNER_SETUP_PREFIX}${RUNNER_HASH}`;
