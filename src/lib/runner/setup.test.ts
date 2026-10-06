import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runnerSetup } from "./setup";
import { RUNNER_SETUP_PREFIX, RUNNER_WORKFLOW_PATH } from "./workflow";
import { currentRunnerFiles } from "./bundle";
import { repository } from "@/lib/db";
import { resetEnvCache } from "@/lib/secrets/env";
import { MockVcsClient, VcsError, resetVcs, setVcs } from "@/lib/vcs";

/** The board asking, as it loads, whether its repository can run CLI agents yet. */

let client: MockVcsClient;

beforeEach(() => {
  (globalThis as { __formicMemoryStore?: unknown }).__formicMemoryStore = undefined;
  MockVcsClient.reset();
  client = new MockVcsClient("acme/widgets");
  setVcs(client);
  vi.stubEnv("GITHUB_TOKEN", "ghp_test");
  resetEnvCache();
});

afterEach(() => {
  resetVcs();
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("runner setup", () => {
  it("opens the setup pull request on a new repository, once", async () => {
    const project = await repository().defaultProject();

    const first = await runnerSetup(project);
    const second = await runnerSetup(project);

    expect(first).toMatchObject({ state: "waiting", update: false });
    expect(second).toEqual(first);
    expect(MockVcsClient.runner().files.get(`${(await currentRunnerFiles()).branch}:${RUNNER_WORKFLOW_PATH}`)).toBeTruthy();
  });

  it("is ready once the workflow is on the base branch", async () => {
    const project = await repository().defaultProject();
    await runnerSetup(project);

    await client.commitFile(project.baseBranch, RUNNER_WORKFLOW_PATH, (await currentRunnerFiles()).workflow, "merged");

    expect(await runnerSetup(project)).toEqual({ state: "ready" });
  });

  it("asks for an update when an older workflow is there", async () => {
    const project = await repository().defaultProject();
    await client.commitFile(project.baseBranch, RUNNER_WORKFLOW_PATH, "name: Formic agent\n", "old");

    expect(await runnerSetup(project)).toMatchObject({ state: "waiting", update: true });
  });

  it("closes a setup pull request left over from an older workflow version", async () => {
    const project = await repository().defaultProject();
    const old = await client.openPullRequest({
      headBranch: `${RUNNER_SETUP_PREFIX}000000000000`,
      baseBranch: project.baseBranch,
      title: "Let Formic run agents in GitHub Actions",
      body: "",
    });

    const setup = await runnerSetup(project);

    expect((await client.pullRequest(old.number)).state).toBe("closed");
    expect(setup).toMatchObject({ state: "waiting" });
    expect(setup.state === "waiting" && setup.setupUrl).not.toBe(old.url);
  });

  it("closes a stale setup pull request even when the workflow is already current", async () => {
    const project = await repository().defaultProject();
    await client.commitFile(project.baseBranch, RUNNER_WORKFLOW_PATH, (await currentRunnerFiles()).workflow, "merged");
    const old = await client.openPullRequest({
      headBranch: `${RUNNER_SETUP_PREFIX}000000000000`,
      baseBranch: project.baseBranch,
      title: "Let Formic run agents in GitHub Actions",
      body: "",
    });

    expect(await runnerSetup(project)).toEqual({ state: "ready" });
    expect((await client.pullRequest(old.number)).state).toBe("closed");
  });

  it("says what permission is missing when GitHub refuses", async () => {
    class Refusing extends MockVcsClient {
      override async readFile(): Promise<string | null> {
        throw new VcsError("Resource not accessible by integration", 403);
      }
    }
    setVcs(new Refusing("acme/widgets"));
    const project = await repository().defaultProject();

    const setup = await runnerSetup(project);

    expect(setup.state).toBe("blocked");
    expect(setup.state === "blocked" && setup.reason).toContain("Workflows");
  });

  it("has nothing to set up without a GitHub token", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    resetEnvCache();
    const project = await repository().defaultProject();

    expect(await runnerSetup(project)).toEqual({ state: "ready" });
  });
});
