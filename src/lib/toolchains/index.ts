import { godot } from "./godot";
import { node } from "./node";
import { python } from "./python";
import type { Host, Toolchain } from "./types";

export type { Host, Toolchain } from "./types";

/**
 * Every toolchain Formic sets up, in the order it sets them up. See ./types for
 * what one is and how to add one. No server imports: the runner's workflow,
 * which has none either, is generated from this.
 */
export const TOOLCHAINS: readonly Toolchain[] = [node, python, godot];

/**
 * The repository's own setup, for what no toolchain could guess: a native
 * library that is git-ignored, a model, a generated file. Run with bash from
 * the repository root, after every toolchain's setup and before any prepare,
 * on both hosts; FORMIC_HOST says which. It may call `formic_note` and
 * `formic_bin` (the prelude below). A failure is reported and does not stop the
 * agent.
 */
export const REPO_SETUP_HOOK = ".github/formic/setup.sh";

/**
 * What an agent reads to learn what was installed and how to run the checks:
 * one section per toolchain, written fresh by each setup. In the home folder
 * rather than the checkout, so it never shows up in a diff.
 */
export const CHECKS_NOTE = "~/.formic/checks.md";

/**
 * The helpers every setup can use, and the place they write to.
 *
 * `formic_bin <file> <name>` puts an installed binary on the PATH of
 * everything that runs after it: later steps of a job through GITHUB_PATH, and
 * in a sandbox, where every command is a fresh shell, through /usr/local/bin.
 * `formic_note <text>` adds a line to the agent's CHECKS_NOTE.
 *
 * Not `set -e`: each setup runs in a subshell that sets it for itself, and
 * one that fails is reported while the rest carry on.
 */
function prelude(host: Host): string {
  return `set +e
FORMIC_CHECKS="$HOME/.formic/checks.md"
FORMIC_BIN="$HOME/.formic/bin"
mkdir -p "$FORMIC_BIN"
: > "$FORMIC_CHECKS"
export FORMIC_CHECKS FORMIC_BIN PATH="$FORMIC_BIN:$PATH"
formic_bin() {
  chmod +x "$1"
  ln -sf "$1" "$FORMIC_BIN/$2"
  if [ -n "\${GITHUB_PATH:-}" ]; then echo "$FORMIC_BIN" >> "$GITHUB_PATH"; fi
${host === "sandbox" ? `  sudo -n ln -sf "$1" "/usr/local/bin/$2" 2>/dev/null || ln -sf "$1" "/usr/local/bin/$2" 2>/dev/null || true
` : ""}}
formic_note() { printf '%s\\n' "$*" >> "$FORMIC_CHECKS"; }
export -f formic_bin formic_note`;
}

/** Which toolchains a repository uses, from the paths in its tree. */
export function detectToolchains(files: Iterable<string>): Toolchain[] {
  const present = new Set(files);
  return TOOLCHAINS.filter((t) => t.markers.some((m) => present.has(m)));
}

/**
 * The bash that sets a fresh machine up for whichever toolchains its checkout
 * uses: each one gated on its markers, so the same script serves every
 * repository. Run from the repository root.
 */
export function setupScript(host: Host, toolchains: readonly Toolchain[] = TOOLCHAINS): string {
  const parts = [prelude(host)];
  for (const t of toolchains) {
    const script = t.setup(host);
    if (script) parts.push(gated(t, `Setting up ${t.name}`, script));
  }
  parts.push(`if [ -f ${REPO_SETUP_HOOK} ]; then
  echo "Running ${REPO_SETUP_HOOK}..."
  FORMIC_HOST=${host} bash ${REPO_SETUP_HOOK}
  if [ "$?" -ne 0 ]; then echo "${REPO_SETUP_HOOK} failed; carrying on without it."; fi
fi`);
  for (const t of toolchains) {
    const script = t.prepare?.(host);
    if (script) parts.push(gated(t, `Preparing the ${t.name} project`, script));
  }
  return `${parts.join("\n\n")}\n`;
}

function gated(t: Toolchain, what: string, script: string): string {
  const test = t.markers.map((m) => `[ -f ${m} ]`).join(" || ");
  return `if ${test}; then
  echo "${what}..."
  (
    set -e
${script
  .split("\n")
  .map((line) => (line ? `    ${line}` : line))
  .join("\n")}
  )
  if [ "$?" -ne 0 ]; then echo "${what} failed; the agent can still install what it needs."; fi
fi`;
}

/** What the job caches for these toolchains, and the files that key it. */
export function cacheFor(toolchains: readonly Toolchain[] = TOOLCHAINS): { paths: string[]; keyFiles: string[] } {
  const paths = toolchains.flatMap((t) => t.cache?.paths ?? []);
  const keyFiles = toolchains.flatMap((t) => t.cache?.keyFiles ?? []);
  return { paths: [...new Set(paths)], keyFiles: [...new Set(keyFiles)] };
}
