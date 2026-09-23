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
export const RUNNER_VERSION = "formic-runner: v2";
/** Where the setup pull request comes from. */
export const RUNNER_SETUP_BRANCH = "formic/setup-runner";

/** Where a planning agent's answer sits on its staging branch. */
export const ANSWER_PATH = ".formic/answer.md";

export const CODE_MODES = ["implement", "fix"] as const;
export const ANSWER_MODES = ["product", "architect", "showcase"] as const;
export type CodeMode = (typeof CODE_MODES)[number];
export type AnswerMode = (typeof ANSWER_MODES)[number];
export type RunnerMode = CodeMode | AnswerMode;

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
  const m = /^Formic (implement|fix|product|architect|showcase) (\S+) · (\S+)$/.exec(title.trim());
  return m ? { mode: m[1] as RunnerMode, ticketKey: m[2]!, job: m[3]! } : null;
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
 * The workflow itself. Inputs reach the shell through `env:` only, never
 * through `${{ }}` inside a script: the prompt is ticket text, and ticket
 * text spliced into bash is a script injection. Each agent gets only its own
 * secret.
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
        description: implement, fix, product, architect or showcase
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
      prompt:
        description: What to do
        required: true

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

      - uses: actions/setup-node@v4
        with:
          node-version: 22

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

      - name: Run the agent
        env:
          CLI: \${{ inputs.cli }}
          MODEL: \${{ inputs.model }}
          PROMPT: \${{ inputs.prompt }}
          FORMIC_SUMMARY: \${{ runner.temp }}/formic-summary.md
          FORMIC_OUTPUT: \${{ runner.temp }}/formic-answer.md
          FORMIC_STDOUT: \${{ runner.temp }}/formic-stdout.md
          CLAUDE_CODE_OAUTH_TOKEN: \${{ inputs.cli == 'claude' && secrets.FORMIC_CLAUDE_CODE_TOKEN || '' }}
          CODEX_CREDENTIAL: \${{ inputs.cli == 'codex' && secrets.FORMIC_CODEX_AUTH || '' }}
          GEMINI_API_KEY: \${{ inputs.cli == 'gemini' && secrets.FORMIC_GEMINI_API_KEY || '' }}
        run: |
          set -euo pipefail
          case "$CLI" in
            claude)
              if [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ]; then echo "No Claude Code token. Add it to the agent in Formic."; exit 1; fi
              args=(-p "$PROMPT" --dangerously-skip-permissions)
              if [ -n "$MODEL" ]; then args+=(--model "$MODEL"); fi
              claude "\${args[@]}" | tee "$FORMIC_STDOUT"
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
              args=(exec --dangerously-bypass-approvals-and-sandbox)
              if [ -n "$MODEL" ]; then args+=(-m "$MODEL"); fi
              codex "\${args[@]}" "$PROMPT" | tee "$FORMIC_STDOUT"
              ;;
            gemini)
              if [ -z "$GEMINI_API_KEY" ]; then echo "No Gemini API key. Add it to the agent in Formic."; exit 1; fi
              args=(-p "$PROMPT" --approval-mode yolo)
              if [ -n "$MODEL" ]; then args+=(-m "$MODEL"); fi
              gemini "\${args[@]}" | tee "$FORMIC_STDOUT"
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
            product|architect|showcase)
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
          if [ ! -s "$FORMIC_SUMMARY" ]; then
            printf '%s: changes from the agent\\n' "$TICKET" > "$FORMIC_SUMMARY"
          fi
          git commit --allow-empty -F "$FORMIC_SUMMARY"
          git push "https://x-access-token:\${GH_TOKEN}@github.com/\${REPO}.git" "HEAD:refs/heads/formic-staging/\${JOB}"
`;
}
