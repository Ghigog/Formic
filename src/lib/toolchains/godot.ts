import type { Toolchain } from "./types";

/**
 * Godot, by its project file.
 *
 * The engine is one self-contained binary, so setup is a download: the
 * official Linux build from godotengine/godot-builds, which runs headless with
 * no display. Which version is the question. project.godot records only the
 * minor version it was saved with (`config/features=PackedStringArray("4.7", ...)`),
 * so Formic takes the newest stable patch of that minor, read from the
 * repository's tags with `git ls-remote` (no API, so no rate limit on a shared
 * runner). A project that must run one exact build pins it in GODOT_VERSION_FILE:
 * `4.7.1`, or a whole tag such as `4.8-rc2`.
 *
 * A fresh checkout has nothing imported (`.godot/` is never committed), and a
 * script that loads an unimported resource fails, so the job imports once
 * after setup. In a sandbox that is left to the agent, whose note says so: a
 * large project's first import can take longer than an in-process run has.
 *
 * Not yet: C# projects, which need the .NET build and an SDK. Their setup
 * stops and says so rather than installing an engine that cannot build them.
 */

/** Where a repository pins the exact Godot it runs on. */
export const GODOT_VERSION_FILE = ".github/formic/godot-version";

/**
 * The test frameworks Formic knows how to run, first found wins. Adding one is
 * an entry here: the agent's note and the CI workflow both read this list.
 */
export const GODOT_TEST_RUNNERS: readonly { name: string; marker: string; command: string }[] = [
  { name: "GUT", marker: "addons/gut/gut_cmdln.gd", command: "godot --headless -s addons/gut/gut_cmdln.gd -gexit" },
];

const install = String.raw`want=""
if [ -f GODOT_VERSION_FILE ]; then want="$(tr -d '[:space:]' < GODOT_VERSION_FILE)"; fi
if [ -z "$want" ]; then
  want="$(sed -n 's/^config\/features=PackedStringArray("\([0-9][0-9.]*\)".*/\1/p' project.godot | head -n 1)"
fi
if [ -z "$want" ]; then
  echo "project.godot names no Godot version. Pin one in GODOT_VERSION_FILE, for example 4.7.1."
  exit 1
fi
if grep -q '^config/features=.*"C#"' project.godot; then
  formic_note "This is a C# Godot project. Formic does not install the .NET build of Godot yet, so there is no engine here to build or test it with."
  echo "C# Godot projects are not supported yet."
  exit 1
fi

case "$want" in
  *-*) tag="$want" ;;
  *)
    pattern="^$(printf '%s' "$want" | sed 's/\./\\./g')(\.[0-9]+)*-stable$"
    tag="$(git ls-remote --tags --refs https://github.com/godotengine/godot-builds | sed -n 's#.*refs/tags/##p' | grep -E "$pattern" | sort -V | tail -n 1)"
    ;;
esac
if [ -z "$tag" ]; then
  echo "No stable Godot release matches $want."
  exit 1
fi
case "$(uname -m)" in
  x86_64) arch=x86_64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "No Linux Godot build for $(uname -m)."; exit 1 ;;
esac

dir="$HOME/.cache/formic/godot/$tag"
bin="$dir/Godot_v$tag""_linux.$arch"
if [ ! -f "$bin" ]; then
  echo "Downloading Godot $tag..."
  mkdir -p "$dir"
  curl -fsSL --retry 3 --max-time 600 -o "$dir/godot.zip" \
    "https://github.com/godotengine/godot-builds/releases/download/$tag/Godot_v$tag""_linux.$arch.zip"
  unzip -q -o "$dir/godot.zip" -d "$dir" 2>/dev/null || python3 -m zipfile -e "$dir/godot.zip" "$dir"
  rm -f "$dir/godot.zip"
fi
formic_bin "$bin" godot
godot --headless --version

formic_note "## Godot"
formic_note "Godot $tag, headless, is installed: run it as \`godot\`. There is no display, so always pass --headless."
formic_note "A fresh checkout has nothing imported. When there is no .godot/ folder, or after you add or change an asset, run \`godot --headless --import\` first: a script that loads an unimported resource fails."`.replaceAll(
  "GODOT_VERSION_FILE",
  GODOT_VERSION_FILE,
);

function testNotes(): string {
  const lines = GODOT_TEST_RUNNERS.map(
    (r, i) =>
      `${i === 0 ? "if" : "elif"} [ -f ${r.marker} ]; then formic_note ${shellQuote(
        `Tests (${r.name}): \`${r.command}\`. A non-zero exit means a test failed; read the log above the summary for which.`,
      )}`,
  );
  return [...lines, `else formic_note "No test framework Formic knows (${GODOT_TEST_RUNNERS.map((r) => r.name).join(", ")}) is installed in addons/."`, "fi"].join(
    "\n",
  );
}

/** The CI step: the first test framework found, or a note that there is none. */
function ciTests(): string {
  const body = [
    ...GODOT_TEST_RUNNERS.map((r, i) => `${i === 0 ? "if" : "elif"} [ -f ${r.marker} ]; then ${r.command}`),
    `else echo "No test framework Formic knows is installed in addons/, so there is nothing to run."`,
    "fi",
  ];
  return `      # A fresh checkout has nothing imported, and the tests load resources.
      - name: Import the project
        run: godot --headless --import

      - name: Run the tests
        run: |
${body.map((l) => `          ${l}`).join("\n")}`;
}

export const godot: Toolchain = {
  id: "godot",
  name: "Godot",
  markers: ["project.godot"],
  setup: () => `${install}\n${testNotes()}`,
  prepare: (host) =>
    host === "job"
      ? `echo "Importing the project..."
log="$HOME/.formic/godot-import.log"
if ! timeout 1200 godot --headless --import > "$log" 2>&1; then
  echo "The import did not finish cleanly; the agent will see the same when it runs it."
fi
tail -n 20 "$log"`
      : null,
  cache: { paths: ["~/.cache/formic/godot"], keyFiles: ["project.godot", GODOT_VERSION_FILE] },
  ci: ciTests(),
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
