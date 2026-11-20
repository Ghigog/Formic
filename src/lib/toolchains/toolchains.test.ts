import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { runsOnPullRequests } from "@/lib/vcs/workflow-triggers";
import { cacheStep, checksWorkflow } from "./actions";
import { GODOT_TEST_RUNNERS } from "./godot";
import { REPO_SETUP_HOOK, TOOLCHAINS, cacheFor, detectToolchains, setupScript, type Toolchain } from "./index";

/**
 * The setup script runs on machines Formic never sees, so it is run here for
 * real, in a scratch checkout with its own home: every branch that does not
 * reach the network.
 */

let repo: string;
let home: string;

beforeEach(() => {
  const root = mkdtempSync(path.join(tmpdir(), "formic-toolchains-"));
  repo = path.join(root, "repo");
  home = path.join(root, "home");
  mkdirSync(repo);
  mkdirSync(home);
});

afterEach(() => {
  rmSync(path.dirname(repo), { recursive: true, force: true });
});

function run(script: string) {
  const result = spawnSync("bash", ["-c", script], {
    cwd: repo,
    // Only these: a GITHUB_PATH from the CI running this test would be written to.
    env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: home },
    encoding: "utf8",
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}`, note: readNote() };
}

function readNote(): string {
  try {
    return readFileSync(path.join(home, ".formic/checks.md"), "utf8");
  } catch {
    return "";
  }
}

/**
 * Runs a script on a machine of Formic's making: only the tools the setup
 * needs, a `uname` that says `os`, and stubs for what is named in `have`.
 * The real machine's xvfb-run must not be seen, so PATH holds nothing else.
 */
function runOn(os: string, have: string[], script: string, env: Record<string, string> = {}) {
  const bin = path.join(path.dirname(repo), "bin");
  mkdirSync(bin, { recursive: true });
  for (const tool of ["mkdir", "chmod", "ln", "cat", "sed", "tr", "head"]) {
    const real = execFileSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
    if (!existsSync(path.join(bin, tool))) symlinkSync(real, path.join(bin, tool));
  }
  const stub = (name: string, body: string) => {
    writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  };
  stub("uname", `echo ${os}`);
  for (const name of have) {
    if (name === "sudo") stub(name, 'shift; [ "$1" = true ] && exit 0; exec "$@"');
    else if (name === "apt-get") stub(name, `echo "$@" >> "${path.join(home, "apt.log")}"; for t in xvfb-run Xvfb; do printf '#!/bin/bash\\n' > "${bin}/$t"; chmod +x "${bin}/$t"; done`);
    else stub(name, "exit 0");
  }
  const result = spawnSync("/bin/bash", ["-c", script], {
    cwd: repo,
    env: { NODE_ENV: "test", PATH: bin, HOME: home, ...env },
    encoding: "utf8",
  });
  let apt = "";
  try {
    apt = readFileSync(path.join(home, "apt.log"), "utf8");
  } catch {}
  return { status: result.status, out: `${result.stdout}${result.stderr}`, note: readNote(), apt };
}

const fake = (id: string, setup: string): Toolchain => ({
  id,
  name: id,
  markers: [`${id}.marker`],
  setup: () => setup,
  ci: null,
});

describe("toolchains", () => {
  it("are told apart by the files at the root", () => {
    expect(detectToolchains(["project.godot", "addons/gut/gut_cmdln.gd"]).map((t) => t.id)).toEqual(["godot"]);
    expect(detectToolchains(["package-lock.json", "requirements.txt"]).map((t) => t.id)).toEqual(["node", "python"]);
    // A marker deeper in the tree is someone else's project, not this one.
    expect(detectToolchains(["game/project.godot"])).toEqual([]);
  });

  it("have ids that are unique and markers that are plain paths", () => {
    expect(new Set(TOOLCHAINS.map((t) => t.id)).size).toBe(TOOLCHAINS.length);
    for (const t of TOOLCHAINS) for (const m of t.markers) expect(m).toMatch(/^[\w./-]+$/);
  });

  it("set up as a script that parses as bash, on both hosts", () => {
    for (const host of ["job", "sandbox"] as const) {
      expect(() => execFileSync("bash", ["-n"], { input: setupScript(host), stdio: "pipe" }), host).not.toThrow();
    }
  });

  it("leave Node and Python to the agent in a sandbox, as before", () => {
    const sandbox = setupScript("sandbox");
    expect(sandbox).not.toContain("npm ci");
    expect(sandbox).not.toContain("pip install");
    expect(setupScript("job")).toContain("npm ci --prefer-offline");
  });

  it("do nothing, and write an empty note, for a repository that uses none of them", () => {
    const result = runOn("Darwin", [], setupScript("sandbox"));
    expect(result.status).toBe(0);
    expect(result.note).toBe("");
  });

  it("carry on past one that fails", () => {
    writeFileSync(path.join(repo, "broken.marker"), "");
    writeFileSync(path.join(repo, "fine.marker"), "");
    const script = setupScript("job", [fake("broken", "false\nformic_note never"), fake("fine", 'formic_note "fine ran"')]);

    const result = run(script);

    expect(result.status).toBe(0);
    expect(result.out).toContain("Setting up broken failed");
    expect(result.note).toContain("fine ran\n");
  });

  it("run the repository's own hook, which can write to the note", () => {
    mkdirSync(path.join(repo, path.dirname(REPO_SETUP_HOOK)), { recursive: true });
    writeFileSync(path.join(repo, REPO_SETUP_HOOK), 'formic_note "hook on $FORMIC_HOST"\n');

    expect(run(setupScript("sandbox")).note).toContain("hook on sandbox\n");
  });

  it("put what they install on the PATH of what runs next", () => {
    writeFileSync(path.join(repo, "tool.marker"), "");
    const install = 'printf "#!/bin/sh\\necho installed" > "$HOME/tool"\nformic_bin "$HOME/tool" tool';
    const result = run(`${setupScript("job", [fake("tool", install)])}\ntool`);
    expect(result.out).toContain("installed");
  });

  it("cache what each of them names, once", () => {
    const { paths, keyFiles } = cacheFor();
    expect(paths).toEqual(expect.arrayContaining(["~/.npm", "~/.cache/pip", "~/.cache/formic/godot"]));
    expect(new Set(paths).size).toBe(paths.length);
    expect(keyFiles).toContain("project.godot");
  });
});

describe("the virtual display", () => {
  const present = ["xvfb-run", "Xvfb", "dpkg"];

  it("is explained in the note, with the wrapper and the time to allow, when xvfb-run is there", () => {
    const result = runOn("Linux", present, setupScript("sandbox", []));
    expect(result.status).toBe(0);
    expect(result.note).toContain("## Display");
    expect(result.note).toContain('no physical screen');
    expect(result.note).toContain('xvfb-run -a -s "-screen 0 1920x1080x24" <command>');
    expect(result.note).toContain("at least 3 minutes");
    expect(result.note).not.toContain("DISPLAY=:99");
  });

  it("installs xvfb, xauth and Mesa when xvfb-run is missing and sudo needs no password", () => {
    const result = runOn("Linux", ["sudo", "apt-get"], setupScript("sandbox", []));
    expect(result.apt).toContain("install -y -qq xvfb xauth libgl1-mesa-dri");
    expect(result.note).toContain("## Display");
  });

  it("notes that there is no display, and carries on, when it cannot install one", () => {
    writeFileSync(path.join(repo, "a.marker"), "");
    const result = runOn("Linux", [], setupScript("sandbox", [fake("a", "formic_note ran")]));
    expect(result.status).toBe(0);
    expect(result.note).toContain("ran");
    expect(result.out).toContain("No virtual display is available");
    expect(result.note).toContain("no virtual display");
  });

  it("starts Xvfb on :99 in a job, and exports it for later steps", () => {
    const github = path.join(home, "env");
    const result = runOn("Linux", present, setupScript("job", []), { GITHUB_ENV: github });
    expect(readFileSync(github, "utf8")).toContain("DISPLAY=:99");
    expect(result.note).toContain("DISPLAY=:99 is already set");
    expect(setupScript("job", [])).toContain("Xvfb :99 -screen 0 1920x1080x24");
  });

  it("leaves a job's own DISPLAY alone, and starts nothing in a sandbox", () => {
    const github = path.join(home, "env");
    runOn("Linux", present, setupScript("job", []), { GITHUB_ENV: github, DISPLAY: ":0" });
    runOn("Linux", present, setupScript("sandbox", []), { GITHUB_ENV: github });
    expect(() => readFileSync(github, "utf8")).toThrow();
    expect(setupScript("sandbox", [])).not.toContain("Xvfb :99");
  });

  it("is not set up at all on macOS", () => {
    const result = runOn("Darwin", present, setupScript("job", []));
    expect(result.note).toBe("");
  });
});

describe("the Godot toolchain", () => {
  const godot = TOOLCHAINS.find((t) => t.id === "godot")!;

  it("tells the agent to screenshot under xvfb-run, not to always pass --headless", () => {
    const script = setupScript("sandbox", [godot]);
    expect(script).toContain("--rendering-driver opengl3");
    expect(script).not.toContain("always pass --headless");
  });

  it("stops with a reason when project.godot names no version", () => {
    writeFileSync(path.join(repo, "project.godot"), "config_version=5\n");
    const result = run(setupScript("sandbox", [godot]));
    expect(result.out).toContain("project.godot names no Godot version");
    expect(result.out).toContain("Setting up Godot failed");
  });

  it("says so, rather than installing an engine that cannot build it, for a C# project", () => {
    writeFileSync(
      path.join(repo, "project.godot"),
      'config/features=PackedStringArray("4.7", "C#", "Forward Plus")\n',
    );
    const result = run(setupScript("sandbox", [godot]));
    expect(result.note).toContain("C# Godot project");
    expect(result.out).not.toContain("Downloading");
  });

  it("imports the project in the job only: a sandbox's minutes are the agent's", () => {
    expect(setupScript("job", [godot])).toContain("godot --headless --import");
    expect(setupScript("sandbox", [godot])).not.toContain("Importing the project");
  });

  /**
   * Stands in for the network and the machine: `git ls-remote` answers with
   * these tags, `uname` says this system, and `curl` records what it was asked
   * for and fails, so the script stops right after choosing a download.
   */
  function fakeMachine(system: string, tags: string[]) {
    const bin = path.join(home, "fake-bin");
    mkdirSync(bin, { recursive: true });
    const script = (name: string, body: string) => {
      writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    };
    script("git", tags.map((t) => `echo "abc\trefs/tags/${t}"`).join("\n"));
    script("uname", `if [ "$1" = -m ]; then echo x86_64; else echo ${system}; fi`);
    script("curl", `echo "$@" > "${path.join(home, "curl-args")}"; exit 22`);
    writeFileSync(path.join(repo, "project.godot"), 'config/features=PackedStringArray("4.7", "Forward Plus")\n');
    return `export PATH="${bin}:$PATH"\n`;
  }
  const curlArgs = () => readFileSync(path.join(home, "curl-args"), "utf8");

  it("picks the newest stable patch by number, so 4.7.10 beats 4.7.9", () => {
    const prelude = fakeMachine("Linux", ["4.7-stable", "4.7.9-stable", "4.7.10-stable", "4.7.11-rc1", "4.8-stable"]);
    const result = run(prelude + setupScript("sandbox", [godot]));
    expect(result.out).toContain("Downloading Godot 4.7.10-stable");
    expect(curlArgs()).toContain("/4.7.10-stable/Godot_v4.7.10-stable_linux.x86_64.zip");
  });

  it("downloads the universal build on macOS", () => {
    const result = run(fakeMachine("Darwin", ["4.7.1-stable"]) + setupScript("sandbox", [godot]));
    expect(result.out).toContain("Downloading Godot 4.7.1-stable");
    expect(curlArgs()).toContain("/4.7.1-stable/Godot_v4.7.1-stable_macos.universal.zip");
  });

  it("runs the macOS app through a script, so it still finds its own files", () => {
    const prelude = fakeMachine("Darwin", ["4.7.1-stable"]);
    const app = path.join(home, ".cache/formic/godot/4.7.1-stable/Godot.app/Contents/MacOS");
    mkdirSync(app, { recursive: true });
    writeFileSync(path.join(app, "Godot"), '#!/bin/sh\necho "ran from $0 with $*"\n');
    const result = run(prelude + setupScript("sandbox", [godot]));
    expect(result.out).toContain(`ran from ${path.join(app, "Godot")} with --headless --version`);
    expect(result.note).toContain("Godot 4.7.1-stable, headless, is installed");
  });

  it("says what to do on a system it has no build for", () => {
    const result = run(fakeMachine("MINGW64_NT-10.0", ["4.7.1-stable"]) + setupScript("sandbox", [godot]));
    expect(result.note).toContain("Install Godot here yourself");
    expect(result.out).not.toContain("Downloading");
  });

  // A file key would hit on the second run and never save again, so every
  // later run would restore the first run's import and redo the rest.
  it("carries the import from run to run, saved fresh by each one", () => {
    const steps = parse(`steps:\n${cacheStep([godot])}`) as {
      steps: Array<{ if?: string; with: { path: string; key: string; "restore-keys": string } }>;
    };
    const work = steps.steps.find((s) => s.with.path.trim() === ".godot")!;
    expect(work.if).toBe("hashFiles('project.godot') != ''");
    expect(work.with.key).toContain("github.run_id");
    expect(work.with.key.startsWith(work.with["restore-keys"])).toBe(true);
  });
});

describe("the checks workflow", () => {
  it("is proposed only where a toolchain has checks to propose", () => {
    expect(checksWorkflow(detectToolchains(["package-lock.json"]), "main")).toBeNull();
    expect(checksWorkflow([], "main")).toBeNull();
  });

  it("is YAML GitHub will run on pull requests, with scripts that parse as bash", () => {
    const text = checksWorkflow(detectToolchains(["project.godot"]), "main")!;
    const doc = parse(text) as { jobs: { checks: { steps: Array<{ name?: string; run?: string }> } } };

    // Formic's own test for whether a repository has CI has to say yes to it,
    // or every setup pull request would propose it again.
    expect(runsOnPullRequests(text, "main")).toBe(true);
    const steps = doc.jobs.checks.steps;
    expect(steps.map((s) => s.name)).toEqual(
      expect.arrayContaining(["Set up the project", "Import the project", "Run the tests"]),
    );
    for (const s of steps.filter((x) => x.run)) {
      expect(() => execFileSync("bash", ["-n"], { input: s.run!, stdio: "pipe" }), s.name).not.toThrow();
    }
    expect(steps.find((s) => s.name === "Run the tests")?.run).toContain(GODOT_TEST_RUNNERS[0]!.command);
  });
});
