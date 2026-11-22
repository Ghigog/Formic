/**
 * Screenshots on the pull request. An agent leaves PNGs in SCREENSHOT_STAGING;
 * its run moves the ones that pass the rules to SCREENSHOT_DIR on the branch
 * (any tool may have made them), and says which it left out in a commit
 * trailer. Formic links them in the pull request body, GitHub having no API
 * for an image in a body, so a committed image is the only way one shows inline.
 */
import { repoHost, repoPath } from "@/lib/vcs/host";

/** Where an agent leaves screenshots, in its checkout. Never committed. */
export const SCREENSHOT_STAGING = ".formic/screenshots";
/** Where the screenshots that pass land on the ticket's branch. */
export const SCREENSHOT_DIR = "docs/screenshots";
/** Most images kept per ticket, and the biggest one, to limit repo bloat. */
export const SCREENSHOT_MAX_COUNT = 8;
export const SCREENSHOT_MAX_BYTES = 1_500_000;
/** One line of a run's commit message per screenshot it left out. */
export const SCREENSHOT_SKIPPED_TRAILER = "Formic-Screenshot-Skipped:";

/**
 * The shell a run executes just before its final commit (GitHub Actions and
 * GitLab CI both): keeps PNG files within the caps, under SCREENSHOT_DIR/<ticket>/,
 * and appends a trailer to $FORMIC_SUMMARY for each one it skips.
 */
export function screenshotStep(): string {
  return `# Screenshots the agent left behind: PNGs within the caps go on the branch.
if [ -d "${SCREENSHOT_STAGING}" ]; then
  shot_kept=0
  for shot in "${SCREENSHOT_STAGING}"/*; do
    [ -f "$shot" ] || continue
    shot_name="$(basename "$shot" | tr -c 'A-Za-z0-9._\\n-' '-')"
    shot_why=""
    case "$(printf '%s' "$shot_name" | tr 'A-Z' 'a-z')" in
      *.png) ;;
      *) shot_why="not a PNG" ;;
    esac
    if [ -z "$shot_why" ] && [ "$(head -c 8 "$shot" | od -An -tx1 | tr -d ' \\n')" != "89504e470d0a1a0a" ]; then shot_why="not a PNG"; fi
    if [ -z "$shot_why" ] && [ "$(wc -c < "$shot")" -gt ${SCREENSHOT_MAX_BYTES} ]; then shot_why="over ${SCREENSHOT_MAX_BYTES} bytes"; fi
    if [ -z "$shot_why" ] && [ "$shot_kept" -ge ${SCREENSHOT_MAX_COUNT} ]; then shot_why="over the limit of ${SCREENSHOT_MAX_COUNT} screenshots"; fi
    if [ -n "$shot_why" ]; then
      printf '\\n${SCREENSHOT_SKIPPED_TRAILER} %s (%s)\\n' "$shot_name" "$shot_why" >> "$FORMIC_SUMMARY"
    else
      mkdir -p "${SCREENSHOT_DIR}/$TICKET"
      cp "$shot" "${SCREENSHOT_DIR}/$TICKET/$shot_name"
      git add -f "${SCREENSHOT_DIR}/$TICKET/$shot_name"
      shot_kept=$((shot_kept + 1))
    fi
  done
  git rm -r -q -f --cached --ignore-unmatch "${SCREENSHOT_STAGING}" > /dev/null
  rm -rf "${SCREENSHOT_STAGING}"
fi`;
}

export function isScreenshotPath(path: string): boolean {
  return path.startsWith(`${SCREENSHOT_DIR}/`);
}

/** What a run left out, and why, from its commit messages. */
export function skippedScreenshots(messages: string[]): string[] {
  return messages
    .flatMap((m) => m.split("\n"))
    .map((l) => l.trim())
    .filter((l) => l.startsWith(SCREENSHOT_SKIPPED_TRAILER))
    .map((l) => l.slice(SCREENSHOT_SKIPPED_TRAILER.length).trim());
}

/** A commit message's text without the trailers about screenshots. */
export function withoutScreenshotTrailers(text: string): string {
  return text
    .split("\n")
    .filter((l) => !l.trim().startsWith(SCREENSHOT_SKIPPED_TRAILER))
    .join("\n")
    .trim();
}

/** Where an image on a branch is served, for a body to show it inline. */
export function screenshotUrl(repoFullName: string, branch: string, path: string): string {
  const enc = (s: string) => s.split("/").map(encodeURIComponent).join("/");
  return repoHost(repoFullName) === "gitlab"
    ? `https://gitlab.com/${repoPath(repoFullName)}/-/raw/${enc(branch)}/${enc(path)}`
    : `https://github.com/${repoPath(repoFullName)}/blob/${enc(branch)}/${enc(path)}?raw=true`;
}

/** The part of the body that shows the screenshots, or "" when there is nothing to say. */
export function screenshotSection(input: {
  repoFullName: string;
  branch: string;
  files: string[];
  skipped: string[];
}): string {
  const shots = input.files.filter(isScreenshotPath);
  if (shots.length === 0 && input.skipped.length === 0) return "";
  return [
    "### Screenshots",
    "",
    ...shots.flatMap((p) => [`![${p.slice(p.lastIndexOf("/") + 1)}](${screenshotUrl(input.repoFullName, input.branch, p)})`, ""]),
    ...(input.skipped.length
      ? [
          `Left out: ${input.skipped.map((s) => `\`${s}\``).join(", ")}. Only PNGs under ${SCREENSHOT_MAX_BYTES / 1_000_000} MB are kept, up to ${SCREENSHOT_MAX_COUNT} per ticket.`,
          "",
        ]
      : []),
  ].join("\n");
}

/** What the agent is told about screenshots, in its prompt. */
export const SCREENSHOT_RULE = `A screenshot that shows the change working, whichever tool made it, goes in ${SCREENSHOT_STAGING}/ as a PNG (create the folder); Formic puts it on the pull request. At most ${SCREENSHOT_MAX_COUNT} files of ${SCREENSHOT_MAX_BYTES / 1_000_000} MB each; others are left out. Leave it out when nothing on screen changed.`;
