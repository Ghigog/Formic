import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runnerSetup } from "./setup";
import { seal } from "@/lib/secrets/vault";
import { RUNNER_SETUP_PREFIX, RUNNER_WORKFLOW_PATH, runnerWorkflow, runnerSetupBranch } from "./workflow";
import { repository } from "@/lib/db";
import { resetEnvCache } from "@/lib/secrets/env";
import { MockVcsClient, VcsError, resetVcs, setVcs } from "@/lib/vcs";
import { CHECKS_WORKFLOW_PATH } from "@/lib/toolchains/actions";

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
  it("reports ready without contacting GitHub when the board has no repository", async () => {
    const project = { ...(await repository().defaultProject()), repoFullName: "" };
    const read = vi.spyOn(client, "readFile");

    expect(await runnerSetup(project)).toEqual({ state: "ready" });
    expect(read).not.toHaveBeenCalled();
    expect(MockVcsClient.runner().files.size).toBe(0);
  });

  it("opens the setup pull request on a new repository, once", async () => {
    const project = await repository().defaultProject();

    const first = await runnerSetup(project, { approve: true });
    const second = await runnerSetup(project, { approve: true });

    expect(first).toMatchObject({ state: "waiting", update: false });
    expect(second).toEqual(first);
    expect(MockVcsClient.runner().files.get(`${runnerSetupBranch()}:${RUNNER_WORKFLOW_PATH}`)).toBeTruthy();
  });

  it("is ready once the workflow is on the base branch", async () => {
    const project = await repository().defaultProject();
    await runnerSetup(project, { approve: true });

    await client.commitFile(project.baseBranch, RUNNER_WORKFLOW_PATH, runnerWorkflow(), "merged");

    expect(await runnerSetup(project, { approve: true })).toEqual({ state: "ready" });
  });

  it("asks for an update when an older workflow is there", async () => {
    const project = await repository().defaultProject();
    await client.commitFile(project.baseBranch, RUNNER_WORKFLOW_PATH, "name: Formic agent\n", "old");

    expect(await runnerSetup(project)).toMatchObject({ state: "waiting", update: true });
  });

  it("offers an update pull request to a workflow that fetches the bundle", async () => {
    const project = await repository().defaultProject();
    const old = runnerWorkflow()
      .replace(/^# formic-runner: .*/m, "# formic-runner: 000000000000")
      .replace(/uses: \S+@[0-9a-f]{40} # v[\d.]+/, "run: curl -fsSL -o loop.mjs \"$BUNDLE\"");
    await client.commitFile(project.baseBranch, RUNNER_WORKFLOW_PATH, old, "old");

    const setup = await runnerSetup(project);

    expect(setup).toMatchObject({ state: "waiting", update: true });
    expect(await client.readFile(RUNNER_WORKFLOW_PATH, runnerSetupBranch())).toMatch(/@[0-9a-f]{40} # v\d/);
  });

  it("adds only the workflow, with no generated file", async () => {
    const project = await repository().defaultProject();

    await runnerSetup(project, { approve: true });

    const onBranch = [...MockVcsClient.runner().files.keys()].filter((k) => k.startsWith(`${runnerSetupBranch()}:`));
    expect(onBranch).toEqual([`${runnerSetupBranch()}:${RUNNER_WORKFLOW_PATH}`]);
  });

  it("closes a setup pull request left over from an older workflow version", async () => {
    const project = await repository().defaultProject();
    const old = await client.openPullRequest({
      headBranch: `${RUNNER_SETUP_PREFIX}000000000000`,
      baseBranch: project.baseBranch,
      title: "Let Formic run agents in GitHub Actions",
      body: "",
    });

    const setup = await runnerSetup(project, { approve: true });

    expect((await client.pullRequest(old.number)).state).toBe("closed");
    expect(setup).toMatchObject({ state: "waiting" });
    expect(setup.state === "waiting" && setup.setupUrl).not.toBe(old.url);
  });

  it("closes a stale setup pull request even when the workflow is already current", async () => {
    const project = await repository().defaultProject();
    await client.commitFile(project.baseBranch, RUNNER_WORKFLOW_PATH, runnerWorkflow(), "merged");
    const old = await client.openPullRequest({
      headBranch: `${RUNNER_SETUP_PREFIX}000000000000`,
      baseBranch: project.baseBranch,
      title: "Let Formic run agents in GitHub Actions",
      body: "",
    });

    expect(await runnerSetup(project)).toEqual({ state: "ready" });
    expect((await client.pullRequest(old.number)).state).toBe("closed");
  });

  it("proposes CI for a Godot repository that has none, in the same pull request", async () => {
    const project = await repository().defaultProject();
    await client.commitFile(project.baseBranch, "project.godot", 'config/features=PackedStringArray("4.7")\n', "game");
    MockVcsClient.runner().noCi = true;

    await runnerSetup(project, { approve: true });

    const checks = MockVcsClient.runner().files.get(`${runnerSetupBranch()}:${CHECKS_WORKFLOW_PATH}`);
    expect(checks).toContain("godot --headless -s addons/gut/gut_cmdln.gd");
  });

  it("proposes no CI where the repository has its own, or Formic has none for its toolchain", async () => {
    const project = await repository().defaultProject();
    await client.commitFile(project.baseBranch, "project.godot", "", "game");
    await runnerSetup(project, { approve: true });
    const branch = runnerSetupBranch();
    expect(MockVcsClient.runner().files.get(`${branch}:${CHECKS_WORKFLOW_PATH}`)).toBeUndefined();

    MockVcsClient.reset();
    client = new MockVcsClient("acme/widgets");
    setVcs(client);
    await client.commitFile(project.baseBranch, "package-lock.json", "{}", "node");
    MockVcsClient.runner().noCi = true;
    await runnerSetup(project, { approve: true });
    expect(MockVcsClient.runner().files.get(`${branch}:${CHECKS_WORKFLOW_PATH}`)).toBeUndefined();
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

describe("asking before the setup pull request", () => {
  const setupFiles = () =>
    [...MockVcsClient.runner().files.keys()].filter((k) => k.startsWith(`${runnerSetupBranch()}:`));

  /** The default board, owned by a person of its own, whose keys are theirs to set. */
  async function ownedProject() {
    const owner = await repository().upsertUser({ githubId: 42, login: "ada", name: null, avatarUrl: null });
    return { ...(await repository().defaultProject()), ownerId: owner.id };
  }

  async function agentOn(projectId: string, ownerId: string, provider: "claude-code" | "anthropic") {
    const preset = await repository().savePreset({
      ownerId,
      column: "in_progress",
      provider,
      name: provider,
      model: "",
      prompt: "",
    });
    await repository().setColumnAgent(projectId, "in_progress", preset.id);
  }

  it("asks before opening anything on a new repository", async () => {
    const project = await repository().defaultProject();

    expect(await runnerSetup(project)).toEqual({ state: "ask", plans: false });
    expect(setupFiles()).toEqual([]);
  });

  it("says when an agent on the board runs on a plan, which only runs in GitHub Actions", async () => {
    const project = await repository().defaultProject();
    await agentOn(project.id, project.ownerId!, "claude-code");

    expect(await runnerSetup(project)).toEqual({ state: "ask", plans: true });
  });

  it("needs no workflow with your own E2B key and agents on API keys", async () => {
    const project = await ownedProject();
    await agentOn(project.id, project.ownerId!, "anthropic");
    await repository().updateUser(project.ownerId!, { e2bKeyCipher: seal("e2b_test"), e2bKeyHint: "test" });

    expect(await runnerSetup(project)).toEqual({ state: "ready" });
    expect(setupFiles()).toEqual([]);
  });

  it("still asks with your own E2B key when an agent runs on a plan", async () => {
    const project = await ownedProject();
    await agentOn(project.id, project.ownerId!, "claude-code");
    await repository().updateUser(project.ownerId!, { e2bKeyCipher: seal("e2b_test"), e2bKeyHint: "test" });

    expect(await runnerSetup(project)).toEqual({ state: "ask", plans: true });
  });

  it("does not count the server's shared E2B key as the person's own", async () => {
    vi.stubEnv("E2B_API_KEY", "e2b_operator");
    resetEnvCache();
    const project = await ownedProject();

    expect(await runnerSetup(project)).toEqual({ state: "ask", plans: false });
  });

  it("opens the pull request once the person says yes", async () => {
    const project = await repository().defaultProject();

    expect(await runnerSetup(project, { approve: true })).toMatchObject({ state: "waiting", update: false });
    expect(setupFiles()).toEqual([`${runnerSetupBranch()}:${RUNNER_WORKFLOW_PATH}`]);
  });
});
