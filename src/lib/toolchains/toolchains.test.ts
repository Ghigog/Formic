import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { runsOnPullRequests } from "@/lib/vcs/workflow-triggers";
import { checksWorkflow } from "./actions";
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
    const result = run(setupScript("sandbox"));
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
    expect(result.note).toBe("fine ran\n");
  });

  it("run the repository's own hook, which can write to the note", () => {
    mkdirSync(path.join(repo, path.dirname(REPO_SETUP_HOOK)), { recursive: true });
    writeFileSync(path.join(repo, REPO_SETUP_HOOK), 'formic_note "hook on $FORMIC_HOST"\n');

    expect(run(setupScript("sandbox")).note).toBe("hook on sandbox\n");
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

describe("the Godot toolchain", () => {
  const godot = TOOLCHAINS.find((t) => t.id === "godot")!;

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
    expect(setupScript("sandbox", [godot])).not.toContain("timeout 1200 godot");
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
