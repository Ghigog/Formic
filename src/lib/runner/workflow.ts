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

export const RUNNER_WORKFLOW_FILE = "formic-agent.yml";
export const RUNNER_WORKFLOW_PATH = `.github/workflows/${RUNNER_WORKFLOW_FILE}`;
export const RUNNER_WORKFLOW_NAME = "Formic agent";
/** Bumped whenever the workflow changes, so old copies get replaced. */
export const RUNNER_VERSION = "formic-runner: v6";
/** Where the setup pull request comes from. */
export const RUNNER_SETUP_BRANCH = "formic/setup-runner";

/** Where a planning agent's answer sits on its staging branch. */
export const ANSWER_PATH = ".formic/answer.md";

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

export const CODE_MODES = ["implement", "fix"] as const;
export const ANSWER_MODES = ["product", "architect", "showcase"] as const;
export type CodeMode = (typeof CODE_MODES)[number];
export type AnswerMode = (typeof ANSWER_MODES)[number];
/** The board's assistant answering a question. */
export type AskMode = "ask";
export type RunnerMode = CodeMode | AnswerMode | AskMode;

export function isAnswerMode(mode: RunnerMode): mode is AnswerMode {
  return (ANSWER_MODES as readonly string[]).includes(mode);
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
  const m = /^Formic (implement|fix|product|architect|showcase|ask) (\S+) · (\S+)$/.exec(title.trim());
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
 */
export const REPORTER_SCRIPT = String.raw`import json, os, time, urllib.request

url = os.environ["REPORT"]
stream = os.environ["FORMIC_STREAM"]
notes = os.environ["FORMIC_NOTES"]
done = os.environ["FORMIC_DONE"]
sent = 0
after = 0
stopped = False


def post(lines):
    global after, stopped
    body = json.dumps({"lines": lines, "after": after}).encode()
    req = urllib.request.Request(url, data=body, method="POST", headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as res:
        reply = json.load(res)
    for note in reply.get("notes", []):
        with open(notes, "a") as f:
            f.write("A note from the person watching this ticket on Formic. Take it into account from here on:\n" + note["text"] + "\n\n")
        after = max(after, int(note["seq"]))
    stopped = bool(reply.get("stop"))


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


while not stopped:
    last = os.path.exists(done)
    try:
        flush()
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
  return `# ${RUNNER_VERSION}
# Installed by Formic (https://formic-board.vercel.app). Runs a coding agent
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
        description: implement, fix, product, architect, showcase or ask
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
      report:
        description: Where to post what the agent does as it works, or empty
        required: false
        default: ""

permissions:
  contents: write

concurrency:
  group: formic-\${{ inputs.job }}

jobs:
  agent:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ inputs.from }}
          persist-credentials: false

      - name: Remember where the agent started
        run: echo "FORMIC_START=$(git rev-parse HEAD)" >> "$GITHUB_ENV"

      # Only matters when the job actually has attachments; harmless
      # otherwise, and nothing later in the job depends on it.
      - name: Make room for downloaded attachments
        run: mkdir -p "$RUNNER_TEMP/formic-attachments"

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      # Every run is a fresh machine. The package caches carry the agent's
      # own install and the project's dependencies from one run to the next,
      # so neither is downloaded from scratch each time.
      - uses: actions/cache@v4
        with:
          path: |
            ~/.npm
            ~/.cache/pip
            ~/.cache/yarn
            ~/.local/share/pnpm/store
          key: formic-\${{ runner.os }}-\${{ hashFiles('**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/requirements*.txt') }}
          restore-keys: formic-\${{ runner.os }}-

      - name: Install the agent
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
        if: inputs.mode == 'implement' || inputs.mode == 'fix'
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
          MODEL: \${{ inputs.model }}
          PROMPT: \${{ inputs.prompt }}
          REPORT: \${{ inputs.report }}
          FORMIC_SUMMARY: \${{ runner.temp }}/formic-summary.md
          FORMIC_OUTPUT: \${{ runner.temp }}/formic-answer.md
          FORMIC_STDOUT: \${{ runner.temp }}/formic-stdout.md
          FORMIC_STREAM: \${{ runner.temp }}/formic-stream.jsonl
          FORMIC_NOTES: \${{ runner.temp }}/formic-notes.md
          FORMIC_DONE: \${{ runner.temp }}/formic-done
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
          git commit --allow-empty -F "$FORMIC_SUMMARY"
          git push "https://x-access-token:\${GH_TOKEN}@github.com/\${REPO}.git" "HEAD:refs/heads/formic-staging/\${JOB}"
`;
}
