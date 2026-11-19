/**
 * How Playtest starts a project, worked out from what sits at its root.
 * See docs/plans/playtest.md, "What it can start". First match wins:
 *
 * 1. `.github/formic/playtest.sh`, which serves on $PORT.
 * 2. Godot (`project.godot`): a single-threaded Web export, served statically.
 * 3. Node (`package.json`): install, then its `dev` script, else `start`.
 * 4. A root `index.html`: served as it is.
 *
 * Pure, so it is tested without a sandbox.
 */

import { ZIP_MEMBER_SCRIPT } from "./zip-member";

export const PLAYTEST_SCRIPT = ".github/formic/playtest.sh";
/** The port the product is asked to listen on when it takes one. */
export const APP_PORT = 3000;
/** Where a Godot export goes, inside the checkout. */
export const GODOT_EXPORT_DIR = "build/playtest-web";

export type PlaytestKind = "script" | "godot" | "node" | "static";

export interface StartPlan {
  kind: PlaytestKind;
  /** Shown while it starts: "Godot game", "Node app". */
  label: string;
  /**
   * Playtest's own setup, before the project's: what it fetches to be able to
   * run it (Godot's Web export template). A failure here is Playtest's, not
   * the project's, so no agent is asked to fix it.
   */
  fetch: string | null;
  /** Run first, in the foreground, from the checkout: install, export. A failure here is the project's. */
  prepare: string | null;
  /** Run in the background from the checkout, for a product that serves itself. Null when served statically. */
  serve: string | null;
  /** The directory the proxy serves from, relative to the checkout, when the product is files. */
  staticDir: string | null;
}

export interface DetectInput {
  /** Every path at the repository root, and `.github/formic/playtest.sh` if it is there. */
  files: string[];
  /** The root package.json's text, if there is one. */
  packageJson: string | null;
  /** `godot --version` once the toolchain installed it, e.g. "4.3.stable.official.77dcf97d8". */
  godotVersion: string | null;
  /** The root export_presets.cfg's text, if there is one. */
  exportPresets: string | null;
}

/** A project Playtest cannot start is the project's to fix (a playtest.sh, a newer Godot); a Godot that did not install is Playtest's. */
export type Detected = { ok: true; plan: StartPlan } | { ok: false; reason: string; fault: "project" | "playtest" };

export const UNSUPPORTED =
  "Playtest runs web apps and Godot games for now. Add .github/formic/playtest.sh to tell it how to start yours: it should serve on $PORT.";

export function detect(input: DetectInput): Detected {
  const has = (f: string) => input.files.includes(f);

  if (has(PLAYTEST_SCRIPT)) {
    return {
      ok: true,
      plan: { kind: "script", label: "your playtest script", fetch: null, prepare: null, serve: `bash ${PLAYTEST_SCRIPT}`, staticDir: null },
    };
  }

  if (has("project.godot")) return godotPlan(input);

  if (input.packageJson !== null) {
    const node = nodePlan(input);
    if (node) return { ok: true, plan: node };
  }

  if (has("index.html")) {
    return { ok: true, plan: { kind: "static", label: "web page", fetch: null, prepare: null, serve: null, staticDir: "." } };
  }

  return { ok: false, reason: UNSUPPORTED, fault: "project" };
}

/** The Godot engine's major and minor version, from `godot --version`. */
export function godotMinor(version: string | null): { major: number; minor: number; folder: string; tag: string } | null {
  const m = version?.trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?\.([a-z0-9]+)/i);
  if (!m) return null;
  const [, major, minor, patch, status] = m;
  const numbers = patch && patch !== "0" ? `${major}.${minor}.${patch}` : `${major}.${minor}`;
  // Templates live in a folder named for the full version, "4.3.stable"; releases are tagged "4.3-stable".
  return { major: Number(major), minor: Number(minor), folder: `${numbers}.${status}`, tag: `${numbers}-${status}` };
}

/** The name of a Web export preset already in export_presets.cfg, if one is. */
export function webPresetName(cfg: string | null): string | null {
  if (!cfg) return null;
  for (const block of cfg.split(/^\[preset\.\d+\]\s*$/m).slice(1)) {
    if (!/^platform="Web"\s*$/m.test(block)) continue;
    const name = block.match(/^name="([^"]+)"\s*$/m)?.[1];
    if (name) return name;
  }
  return null;
}

/** A Web export preset Playtest writes when the project has none. Single-threaded, so no special headers. */
export const PLAYTEST_PRESET = [
  "[preset.0]",
  "",
  'name="Playtest Web"',
  'platform="Web"',
  "runnable=true",
  'export_filter="all_resources"',
  `export_path="${GODOT_EXPORT_DIR}/index.html"`,
  "",
  "[preset.0.options]",
  "",
  "variant/thread_support=false",
  "",
].join("\n");

function godotPlan(input: DetectInput): Detected {
  const v = godotMinor(input.godotVersion);
  if (!v) return { ok: false, reason: "Godot did not install, so the game cannot be exported. The log above says why.", fault: "playtest" };
  // Before 4.3 a Web export needs threads, and threads need headers a frame inside Formic cannot have.
  if (v.major < 4 || (v.major === 4 && v.minor < 3)) {
    return {
      ok: false,
      reason: `Playtest exports Godot games to the web single-threaded, which needs Godot 4.3 or newer (this project is on ${v.major}.${v.minor}). Add .github/formic/playtest.sh to serve it your own way.`,
      fault: "project",
    };
  }
  const preset = webPresetName(input.exportPresets);
  const templates = `$HOME/.local/share/godot/export_templates/${v.folder}`;
  const tpz = `https://github.com/godotengine/godot-builds/releases/download/${v.tag}/Godot_v${v.tag}_export_templates.tpz`;
  // Only the Web template, read out of the 1.3 GB archive by range: the whole archive does not fit on the sandbox's disk.
  const fetch = [
    "set -e",
    `if [ ! -f "${templates}/web_nothreads_release.zip" ]; then`,
    '  echo "Fetching the Web export template..."',
    `  python3 - "${tpz}" "${templates}" templates/web_nothreads_release.zip templates/version.txt <<'FORMIC_ZIP'${ZIP_MEMBER_SCRIPT}FORMIC_ZIP`,
    "fi",
  ].join("\n");
  const prepare = [
    "set -e",
    ...(preset
      ? []
      : [
          "# No Web preset: write one. The sandbox is thrown away, so the project's own file is not changed anywhere else.",
          `cat > export_presets.cfg <<'FORMIC_PRESET'\n${PLAYTEST_PRESET}FORMIC_PRESET`,
        ]),
    `mkdir -p ${GODOT_EXPORT_DIR}`,
    'echo "Importing the project..."',
    "godot --headless --import || true",
    'echo "Exporting to the web..."',
    `godot --headless --export-release ${shellWord(preset ?? "Playtest Web")} ${GODOT_EXPORT_DIR}/index.html`,
  ].join("\n");
  return { ok: true, plan: { kind: "godot", label: "Godot game", fetch, prepare, serve: null, staticDir: GODOT_EXPORT_DIR } };
}

function nodePlan(input: DetectInput): StartPlan | null {
  let scripts: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(input.packageJson ?? "{}") as { scripts?: Record<string, unknown> };
    scripts = parsed.scripts ?? {};
  } catch {
    return null;
  }
  const script = typeof scripts.dev === "string" ? "dev" : typeof scripts.start === "string" ? "start" : null;
  const has = (f: string) => input.files.includes(f);
  const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
  const install =
    pm === "pnpm"
      ? "corepack enable && pnpm install --frozen-lockfile"
      : pm === "yarn"
        ? "corepack enable && yarn install"
        : has("package-lock.json")
          ? "npm ci"
          : "npm install";
  if (!script) {
    // A package.json for tooling, beside a page that is the product.
    if (has("index.html")) return { kind: "static", label: "web page", fetch: null, prepare: install, serve: null, staticDir: "." };
    return null;
  }
  return { kind: "node", label: "web app", fetch: null, prepare: install, serve: `${pm} run ${script}`, staticDir: null };
}

/** The port a dev server says it is on, from a line of its output. */
export function portFromLine(line: string): number | null {
  // Colour codes would split "localhost:" from the number.
  const clean = line.replace(/\u001b\[[0-9;]*m/g, "");
  const m = clean.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w.-]+):(\d{2,5})/);
  if (!m) return null;
  const port = Number(m[1]);
  return port > 0 && port < 65536 ? port : null;
}

function shellWord(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
