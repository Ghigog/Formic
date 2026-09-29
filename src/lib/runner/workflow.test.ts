import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  ALREADY_DONE_TRAILER,
  RUNNER_WORKFLOW_PATH,
  RUNNER_VERSION,
  USAGE_TRAILER,
  parseRunTitle,
  runTitle,
  runnerWorkflow,
} from "./workflow";

/**
 * The workflow Formic installs in someone else's repository, checked the way
 * such a file must be: it has to parse as YAML (GitHub refuses what does not),
 * every script it runs has to parse as bash, and the copy this repository has
 * checked in has to be what the generator just produced.
 */

const text = runnerWorkflow();

interface Step {
  name?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
}

const doc = parse(text) as {
  on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
  jobs?: { agent?: { steps?: Step[] } };
};

const steps = doc.jobs?.agent?.steps ?? [];
const step = (name: string): Step => {
  const found = steps.find((s) => s.name === name);
  expect(found, `no step named ${name}`).toBeTruthy();
  return found!;
};

describe("the installed workflow", () => {
  it("parses as the YAML a runner will accept", () => {
    expect(() => parse(text)).not.toThrow();
    expect(text.startsWith(`# ${RUNNER_VERSION}`)).toBe(true);
    expect(Object.keys(doc.on?.workflow_dispatch?.inputs ?? {})).toEqual(
      expect.arrayContaining(["job", "mode", "ticket", "cli", "model", "from", "secret", "prompt", "bundle", "report", "merge"]),
    );
  });

  it("has every script in it parse as bash", () => {
    for (const s of steps.filter((x) => x.run)) {
      expect(
        () => execFileSync("bash", ["-n"], { input: s.run!, stdio: "pipe" }),
        `${s.name ?? "(unnamed step)"}`,
      ).not.toThrow();
    }
  });

  it("carries mode loop: fetch the entry, run it, hand its report back", () => {
    const run = step("Run the agent");
    expect(run.if).toBeUndefined();
    expect(run.env?.MODE).toBe("${{ inputs.mode }}");
    expect(run.env?.FORMIC_API_KEY).toContain("FORMIC_API_KEY_");
    expect(run.run).toContain('case "$MODE" in');
    expect(run.run).toContain("formic-loop.mjs");
    // The checkout it works in is the job's own, not a clone of its own.
    expect(run.run).toContain(".repo.dir = $dir");
    // What the ticket gets from the run's report.
    expect(run.run).toContain(USAGE_TRAILER);
    expect(run.run).toContain(ALREADY_DONE_TRAILER);
    // A loop run needs the repository's dependencies, but no CLI agent.
    expect(step("Install the project's dependencies").if).toContain("inputs.mode == 'loop'");
    expect(step("Install the agent").if).toBe("inputs.mode != 'loop'");
  });

  it("is what this repository has checked in, refreshed by the generator alone", () => {
    const root = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
    expect(readFileSync(path.join(root, RUNNER_WORKFLOW_PATH), "utf8")).toBe(text);
  });

  it("puts loop runs in a title its completion can read back", () => {
    expect(parseRunTitle(runTitle("loop", "T-7", "card--abc"))).toEqual({
      mode: "loop",
      ticketKey: "T-7",
      job: "card--abc",
    });
    // The other modes keep parsing exactly as they did.
    expect(parseRunTitle(runTitle("implement", "T-1", "card--def"))?.mode).toBe("implement");
    expect(parseRunTitle("Formic deploy T-1 · card--ghi")).toBeNull();
  });
});
