/**
 * The GitLab CI job Formic installs in a project, the counterpart of the
 * GitHub Actions workflow in ./workflow.ts, step for step: check the agent's
 * secret, check out where the run starts (carrying on from a checkpoint),
 * merge another branch in when asked, install the agent and the project's
 * dependencies, report as it works, run it, and push its work to a
 * formic-staging/ branch for Formic to check. Nothing reaches a real branch
 * from here.
 *
 * Inputs arrive as pipeline variables (FORMIC_<INPUT>, see ./gitlab-ci.ts)
 * and reach the script as environment variables only, never spliced into it:
 * the prompt is ticket text.
 *
 * The job pushes with its own CI_JOB_TOKEN, which the setup lets push to the
 * repository. Unlike GitHub's, it may push changes to CI files, so nothing is
 * carried; and a merge it resolves is pushed as the merge commit it is.
 *
 * An agent on an API key runs Formic's own loop: the runner release pinned by
 * commit, downloaded from GitHub and checked against its SHA-256 before it
 * runs, so nothing unverified ever runs and nothing is fetched from Formic.
 *
 * No server imports.
 */

import { createHash } from "node:crypto";
import { parseDocument, isSeq, YAMLSeq } from "yaml";

import { REPO_SETUP_HOOK, setupScript } from "../toolchains";
import {
  ALREADY_DONE_TRAILER,
  ANSWER_PATH,
  ASSISTANT_CHANGE_SUFFIX,
  CHECKPOINT_TRAILER,
  MERGED_TRAILER,
  NOTES_HOOK,
  REPORTER_SCRIPT,
  RUNNER_ACTION,
  RUNNER_JOB_MINUTES,
  RUNNER_SETUP_PREFIX,
  USAGE_TRAILER,
  ATTACHMENTS_DIR_VAR,
} from "./workflow";
import { GITLAB_RUN_VARIABLE, GITLAB_RUNNER_JOB, GITLAB_RUNNER_PATH, SKIP_CI_LINE } from "./gitlab-ci";

/**
 * The SHA-256 of the pinned runner release's dist/index.mjs, and the release
 * commit it was taken from. Bumping RUNNER_ACTION means recording the new
 * release's hash here too (docs/runner-action-release.md); a test fails until
 * the two commits agree.
 */
export const RUNNER_BUNDLE = {
  sha: "d9fc607520b3842efee2b885e9c2ee4e4130237c",
  sha256: "4e5dadd55172dd56c1faa57b74f5b24ab7fdd0b7ae11518ee55b259ad6de4eb4",
} as const;
export const RUNNER_BUNDLE_SHA256 = RUNNER_BUNDLE.sha256;

/** The image the job runs in: Node for the agents, with git, python3 and curl. */
export const GITLAB_RUNNER_IMAGE = "node:22-bookworm";

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line ? pad + line : line))
    .join("\n");
}

/** The inputs a run carries, the same as the GitHub workflow's. */
const INPUTS = ["job", "mode", "ticket", "cli", "model", "from", "secret", "prompt", "report", "merge", "timeout"];

/** The job's script: one bash program, so its steps share their variables. */
function script(): string {
  const reserved = INPUTS.map((i) => `FORMIC_${i.toUpperCase()}`).join("|");
  return `set -euo pipefail
export RUNNER_TEMP="$(mktemp -d)"
T="$RUNNER_TEMP"
JOB="$FORMIC_JOB"; MODE="$FORMIC_MODE"; TICKET="$FORMIC_TICKET"; CLI="$FORMIC_CLI"
MODEL="\${FORMIC_MODEL:-}"; FROM="$FORMIC_FROM"; MERGE="\${FORMIC_MERGE:-}"; REPORT="\${FORMIC_REPORT:-}"
export JOB MODE TICKET CLI MODEL
PUSH_URL="https://gitlab-ci-token:\${CI_JOB_TOKEN}@\${CI_SERVER_HOST}/\${CI_PROJECT_PATH}.git"

# The agent's secret, first, so a missing one fails at once and says where to
# add it. Only a FORMIC_ variable of the project's own may be named: never one
# of the run's inputs. A File variable holds its value in a file.
case "$FORMIC_SECRET" in
  ${reserved}) echo "The agent's secret cannot be one of the run's inputs."; exit 1 ;;
  FORMIC_*) ;;
  *) echo "The agent's secret must be a FORMIC_ variable."; exit 1 ;;
esac
SECRET_VALUE="\${!FORMIC_SECRET:-}"
if [ -n "$SECRET_VALUE" ] && [ -f "$SECRET_VALUE" ]; then SECRET_VALUE="$(cat "$SECRET_VALUE")"; fi
if [ -z "$SECRET_VALUE" ]; then
  echo "Add $FORMIC_SECRET in Settings, CI/CD, Variables: \${CI_PROJECT_URL}/-/settings/ci_cd"
  exit 1
fi

git config --global user.name "Formic Agent"
git config --global user.email formic-agent@users.noreply.github.com
git fetch --quiet --unshallow origin 2>/dev/null || true
git fetch --quiet origin "+refs/heads/*:refs/remotes/origin/*"
if [[ "$FROM" =~ ^[0-9a-f]{40}$ ]]; then git checkout -q --detach "$FROM"; else git checkout -q --detach "origin/$FROM"; fi

# Started on a checkpoint (Formic names one by its commit, never by a
# branch): carry on from it, its work uncommitted in the checkout and its
# notes in the progress file, as it was left.
if [[ "$FROM" =~ ^[0-9a-f]{40}$ ]] && git log -1 --format=%B | grep -q '^${CHECKPOINT_TRAILER}'; then
  git log -1 --format=%b | grep -v '^${CHECKPOINT_TRAILER}' | grep -vF '${SKIP_CI_LINE}' > "$T/formic-progress.md" || true
  git reset -q HEAD~1
  echo "Carrying on from the checkpoint of a run that stopped."
fi
export FORMIC_START="$(git rev-parse HEAD)"

# Conflicts and all: resolving them is the agent's work.
FORMIC_MERGED=""
if [ -n "$MERGE" ]; then
  merged="$(git rev-parse "origin/$MERGE")"
  if ! git merge --no-commit --no-ff "$merged"; then
    if [ -z "$(git diff --name-only --diff-filter=U)" ]; then echo "Could not merge $MERGE."; exit 1; fi
  fi
  FORMIC_MERGED="$merged"
fi

mkdir -p "$T/formic-attachments"
export ${ATTACHMENTS_DIR_VAR}="$T/formic-attachments"
if ! command -v jq >/dev/null; then
  (apt-get update -qq && apt-get install -yqq jq >/dev/null) || { echo "Could not install jq."; exit 1; }
fi

if [ "$MODE" != "loop" ]; then
  case "$CLI" in
    claude) npm install -g --silent @anthropic-ai/claude-code ;;
    codex) npm install -g --silent @openai/codex ;;
    gemini) npm install -g --silent @google/gemini-cli ;;
    *) echo "Unknown agent: $CLI"; exit 1 ;;
  esac
fi

# Ready before the agent starts, so it spends its turns on the ticket:
# the checkout's toolchains, then the repository's own ${REPO_SETUP_HOOK}.
# Never fatal: the agent can still install what it needs itself.
if [ "$MODE" = "implement" ] || [ "$MODE" = "fix" ] || [ "$MODE" = "loop" ] || { [ "$MODE" = "ask" ] && { [ "$TICKET" = "sentinel" ] || [ "$TICKET" = "assistant" ]; }; }; then
  (
    set +e
${indent(setupScript("job").trimEnd(), 4)}
  ) || echo "Setting up the project's dependencies failed; carrying on."
fi

export FORMIC_STREAM="$T/formic-stream.jsonl" FORMIC_NOTES="$T/formic-notes.md" FORMIC_DONE="$T/formic-done"
export FORMIC_PROGRESS="$T/formic-progress.md" FORMIC_SUMMARY="$T/formic-summary.md"
export FORMIC_OUTPUT="$T/formic-answer.md" FORMIC_STDOUT="$T/formic-stdout.md"
: > "$FORMIC_STREAM"

# What the agent does, posted to Formic as it works, beside everything below.
# Coding runs save checkpoints; a run resolving merge conflicts does not.
if [ -n "$REPORT" ]; then
  if { [ "$MODE" = "implement" ] || [ "$MODE" = "fix" ] || [ "$MODE" = "loop" ]; } && [ -z "$MERGE" ]; then export FORMIC_CHECKPOINT=on; fi
  cat > "$T/formic-report.py" <<'FORMIC_REPORTER'
${REPORTER_SCRIPT}
FORMIC_REPORTER
  REPORT="$REPORT" nohup python3 "$T/formic-report.py" > /dev/null 2>&1 &
  echo $! > "$T/formic-reporter.pid"
fi

# Whatever happens below: tell the reporter it is the last round, and give it
# a moment to post the end of the stream and the final checkpoint.
stop_reporting() {
  touch "$FORMIC_DONE"
  pid="$(cat "$T/formic-reporter.pid" 2>/dev/null || true)"
  for _ in $(seq 1 60); do
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 1
  done
}
trap stop_reporting EXIT

MINUTES="\${FORMIC_TIMEOUT:-${RUNNER_JOB_MINUTES}}"

if [ "$MODE" = "loop" ]; then
  # Formic's own loop, the runner release pinned by commit, checked before it runs.
  case "$FORMIC_SECRET" in FORMIC_API_KEY_*) ;; *) echo "A loop run reads its key from a FORMIC_API_KEY_ variable."; exit 1 ;; esac
  curl -fsSL "https://raw.githubusercontent.com/${RUNNER_ACTION.repo}/${RUNNER_ACTION.sha}/dist/index.mjs" -o "$T/formic-runner.mjs"
  echo "${RUNNER_BUNDLE_SHA256}  $T/formic-runner.mjs" | sha256sum -c --quiet - || { echo "The runner download did not match its release."; exit 1; }
  INPUT_JOB="$JOB" INPUT_MODE="$MODE" INPUT_TICKET="$TICKET" INPUT_CLI="$CLI" INPUT_MODEL="$MODEL" \\
  INPUT_FROM="$FROM" INPUT_SECRET="$FORMIC_SECRET" INPUT_PROMPT="$FORMIC_PROMPT" INPUT_REPORT="$REPORT" INPUT_MERGE="$MERGE" \\
  FORMIC_API_KEY="$SECRET_VALUE" FORMIC_REPORT="$T/formic-report.json" GITHUB_WORKSPACE="$CI_PROJECT_DIR" \\
    timeout "\${MINUTES}m" node "$T/formic-runner.mjs"
  {
    printf '%s: %s\\n\\n' "$TICKET" "$(jq -r '.summary' "$T/formic-report.json")"
    jq -r '.detail' "$T/formic-report.json"
    if [ "$(jq -r '.handoff | length' "$T/formic-report.json")" -gt 0 ]; then
      printf '\\nFor you:\\n'
      jq -r '.handoff[] | "- " + .' "$T/formic-report.json"
    fi
    printf '\\n${USAGE_TRAILER} %s\\n' "$(jq -c '.usage | {model, tokensIn, tokensOut, costCents}' "$T/formic-report.json")"
  } > "$FORMIC_SUMMARY"
  if [ "$(jq -r '.alreadyDone' "$T/formic-report.json")" = "true" ]; then
    printf '${ALREADY_DONE_TRAILER}\\n' >> "$FORMIC_SUMMARY"
    if git diff --quiet && git diff --cached --quiet; then git commit -q --allow-empty -m "$TICKET: nothing to change"; fi
  fi
else
  export CLAUDE_CODE_ENABLE_TODO_TOOLS=true CLAUDE_CODE_ENABLE_TASKS=false
  case "$CLI" in
    claude)
      printf '%s' '${NOTES_HOOK}' > "$T/formic-hooks.json"
      args=(-p "$FORMIC_PROMPT" --output-format stream-json --verbose --settings "$T/formic-hooks.json" --dangerously-skip-permissions)
      if [ -n "$MODEL" ]; then args+=(--model "$MODEL"); fi
      CLAUDE_CODE_OAUTH_TOKEN="$SECRET_VALUE" timeout "\${MINUTES}m" claude "\${args[@]}" | tee -a "$FORMIC_STREAM"
      jq -Rrj 'fromjson? | select(.type == "result") | (.result // empty)' "$FORMIC_STREAM" > "$FORMIC_STDOUT"
      ;;
    codex)
      if [[ "$SECRET_VALUE" == \\{* ]]; then
        mkdir -p ~/.codex
        printf '%s' "$SECRET_VALUE" > ~/.codex/auth.json
      else
        export CODEX_API_KEY="$SECRET_VALUE" OPENAI_API_KEY="$SECRET_VALUE"
      fi
      args=(exec --json --output-last-message "$FORMIC_STDOUT" --dangerously-bypass-approvals-and-sandbox)
      if [ -n "$MODEL" ]; then args+=(-m "$MODEL"); fi
      timeout "\${MINUTES}m" codex "\${args[@]}" "$FORMIC_PROMPT" | tee -a "$FORMIC_STREAM"
      ;;
    gemini)
      mkdir -p ~/.gemini
      printf '%s' '{"context":{"fileName":["AGENTS.md","GEMINI.md"]}}' > ~/.gemini/settings.json
      args=(-p "$FORMIC_PROMPT" --output-format stream-json --approval-mode yolo)
      if [ -n "$MODEL" ]; then args+=(-m "$MODEL"); fi
      GEMINI_API_KEY="$SECRET_VALUE" timeout "\${MINUTES}m" gemini "\${args[@]}" | tee -a "$FORMIC_STREAM"
      jq -Rrj 'fromjson? | select(.type == "message" and .role == "assistant") | (.content // empty)' "$FORMIC_STREAM" > "$FORMIC_STDOUT"
      ;;
  esac
fi
unset SECRET_VALUE

stop_reporting
trap - EXIT

# Hand the work to Formic, on a formic-staging/ branch.
case "$MODE" in
  product|architect|showcase|ask)
    # The board's assistant may have changed the code: that goes to a branch
    # of its own, for Formic to offer as a merge request.
    if [ "$MODE" = "ask" ] && [ "$TICKET" = "assistant" ]; then
      git add -A
      if ! git diff --cached --quiet; then
        git commit -q -m "Changes from the board's assistant"
        git push -q "$PUSH_URL" "HEAD:refs/heads/formic-staging/\${JOB}${ASSISTANT_CHANGE_SUFFIX}"
      fi
    fi
    # The answer, on its own: only it leaves on this branch.
    git reset -q --hard "$FORMIC_START"
    git clean -qfdx
    answer="$FORMIC_OUTPUT"
    if [ ! -s "$answer" ]; then answer="$FORMIC_STDOUT"; fi
    if [ ! -s "$answer" ]; then echo "The agent finished without an answer."; exit 1; fi
    mkdir -p "$(dirname "${ANSWER_PATH}")"
    cp "$answer" "${ANSWER_PATH}"
    git add -f "${ANSWER_PATH}"
    git commit -q -m "$TICKET: $MODE answer"
    git push -q "$PUSH_URL" "HEAD:refs/heads/formic-staging/\${JOB}"
    exit 0
    ;;
esac
git add -A
if [ -n "$FORMIC_MERGED" ] && git diff --cached "$FORMIC_START" | grep -qE '^\\+(<<<<<<<|>>>>>>>)( |$)'; then
  echo "Conflict markers are still in the change."
  exit 1
fi
# A resolution that kept the branch's side changes no files, yet is still the merge.
if [ -z "$FORMIC_MERGED" ] && git diff --cached --quiet && [ "$(git rev-parse HEAD)" = "$FORMIC_START" ]; then
  echo "The agent finished without changing anything."
  exit 1
fi
# No summary written: the agent's last words are the next best thing.
if [ ! -s "$FORMIC_SUMMARY" ] && [ -s "$FORMIC_STDOUT" ]; then
  { printf '%s: %s\\n\\n' "$TICKET" "$(head -n 1 "$FORMIC_STDOUT" | cut -c 1-70)"; tail -n +2 "$FORMIC_STDOUT"; } > "$FORMIC_SUMMARY"
fi
if [ ! -s "$FORMIC_SUMMARY" ]; then printf '%s: changes from the agent\\n' "$TICKET" > "$FORMIC_SUMMARY"; fi
# A CLI agent reports tokens only, from its stream. The loop wrote its own.
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
  if [ -n "$usage" ]; then printf '\\n${USAGE_TRAILER} %s\\n' "$(jq -c . <<< "$usage")" >> "$FORMIC_SUMMARY"; fi
fi
if [ -n "$FORMIC_MERGED" ]; then printf '\\n${MERGED_TRAILER} %s\\n' "$FORMIC_MERGED" >> "$FORMIC_SUMMARY"; fi
# A merge stays the merge commit it is: GitLab cannot add the parent later.
git commit -q --allow-empty -F "$FORMIC_SUMMARY"
git push -q "$PUSH_URL" "HEAD:refs/heads/formic-staging/\${JOB}"`;
}

function configBody(): string {
  return `# Installed by Formic. Runs a coding agent on your own plan, or Formic's
# own loop on an API key, when a Formic card starts a pipeline with
# ${GITLAB_RUN_VARIABLE} set, and pushes its work to a formic-staging/ branch
# for Formic to check. It never runs in any other pipeline. Formic replaces
# this file when its version changes.
${GITLAB_RUNNER_JOB}:
  image: ${GITLAB_RUNNER_IMAGE}
  stage: test
  timeout: ${RUNNER_JOB_MINUTES}m
  interruptible: true
  rules:
    - if: '$${GITLAB_RUN_VARIABLE} == "1" && $FORMIC_JOB'
  variables:
    GIT_DEPTH: "50"
  script:
    - |
${indent(script(), 6)}
`;
}

/** Which version of the config a project has, worked out from its own text. */
export function gitlabRunnerVersion(): string {
  return `formic-runner-gitlab: ${createHash("sha256").update(configBody()).digest("hex").slice(0, 12)}`;
}

export function gitlabRunnerConfig(): string {
  return `# ${gitlabRunnerVersion()}\n${configBody()}`;
}

/** Where the GitLab setup merge request comes from: a branch of its own per version. */
export function gitlabSetupBranch(): string {
  return `${RUNNER_SETUP_PREFIX}gitlab-${gitlabRunnerVersion().split(": ")[1]}`;
}

/**
 * The project's .gitlab-ci.yml with Formic's file included, keeping
 * everything else (comments too) as it was; or null when it already
 * includes it. A project with no CI file gets one with only the include.
 */
export function withRunnerInclude(current: string | null): string | null {
  const entry = { local: GITLAB_RUNNER_PATH };
  if (current === null || current.trim() === "") {
    return `# Formic's agent job: see ${GITLAB_RUNNER_PATH}.\ninclude:\n  - local: ${GITLAB_RUNNER_PATH}\n`;
  }
  if (current.includes(GITLAB_RUNNER_PATH)) return null;
  const doc = parseDocument(current);
  if (doc.errors.length > 0) {
    throw new Error(`.gitlab-ci.yml does not parse: ${doc.errors[0]!.message}`);
  }
  const include = doc.get("include", true);
  if (include === undefined || include === null) {
    // Kept at the top, where readers look for it.
    return `include:\n  - local: ${GITLAB_RUNNER_PATH}\n\n${current}`;
  }
  if (isSeq(include)) {
    (include as YAMLSeq).add(doc.createNode(entry));
  } else {
    const seq = new YAMLSeq();
    seq.add(include);
    seq.add(doc.createNode(entry));
    doc.set("include", seq);
  }
  return doc.toString();
}

/** The setup merge request's description. */
export function gitlabSetupBody(): string {
  return [
    "Formic runs coding agents in this project's GitLab CI: Claude Code, Codex and Gemini CLI on your own plan, and agents on an API key through Formic's runner.",
    "",
    `This adds \`${GITLAB_RUNNER_PATH}\` and includes it from \`.gitlab-ci.yml\`. Its one job, \`${GITLAB_RUNNER_JOB}\`, only runs in pipelines Formic starts. It pushes the agent's work to a \`formic-staging/\` branch, never to a real branch: Formic checks the change against the ticket's file scope first, then opens a merge request as usual. For an agent on an API key it runs Formic's runner, pinned to one release by its commit and checked against its SHA-256, so nothing is downloaded from Formic when a job runs.`,
    "",
    "Formic also set this project to let pipeline jobs push with their own token (Settings, CI/CD, Job token permissions) and to let developers run pipelines with variables, which is how Formic hands a job its ticket.",
    "",
    "Agents read their sign-in from CI/CD variables named FORMIC_…, which you add in Settings, CI/CD, Variables. Formic only ever stores their names.",
    "",
    "Merge this once, then retry the card.",
  ].join("\n");
}
