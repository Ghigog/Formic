import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  RUNNER_BUNDLE,
  RUNNER_BUNDLE_SHA256,
  gitlabRunnerConfig,
  gitlabRunnerVersion,
  gitlabSetupBranch,
  withRunnerInclude,
} from "./gitlab-ci-config";
import { GITLAB_CI_PATH, GITLAB_RUNNER_JOB, GITLAB_RUNNER_PATH } from "./gitlab-ci";
import { RUNNER_ACTION, RUNNER_SETUP_PREFIX } from "./workflow";
import { runnerSetup } from "./setup";
import { loopRunnerReady } from "./runner";
import { repository } from "@/lib/db";
import { resetEnvCache } from "@/lib/secrets/env";
import { MockVcsClient, resetVcs, setVcs } from "@/lib/vcs";

/** The GitLab CI job Formic installs, and the merge request that installs it. */

describe("the GitLab CI job", () => {
  const job = () => (parse(gitlabRunnerConfig()) as Record<string, Record<string, unknown>>)[GITLAB_RUNNER_JOB]!;

  it("runs only in pipelines Formic starts, never in the project's own", () => {
    expect(job().rules).toEqual([{ if: '$FORMIC_RUN == "1" && $FORMIC_JOB' }]);
  });

  it("carries its version on the first line, so an old copy is replaced", () => {
    expect(gitlabRunnerConfig().split("\n")[0]).toBe(`# ${gitlabRunnerVersion()}`);
    expect(gitlabSetupBranch().startsWith(RUNNER_SETUP_PREFIX)).toBe(true);
  });

  it("knows the SHA-256 of the release the GitHub workflow pins, not an older one", () => {
    expect(RUNNER_BUNDLE.sha).toBe(RUNNER_ACTION.sha);
  });

  it("checks the pinned runner release against its SHA-256 before running it", () => {
    const script = String((job().script as string[])[0]);
    expect(script).toContain(`raw.githubusercontent.com/${RUNNER_ACTION.repo}/${RUNNER_ACTION.sha}/dist/index.mjs`);
    expect(script).toContain(`echo "${RUNNER_BUNDLE_SHA256}  $T/formic-runner.mjs" | sha256sum -c`);
  });

  it("reads the prompt and every input from the environment, never spliced into the script", () => {
    const script = String((job().script as string[])[0]);
    expect(script).not.toMatch(/\$\[\[|\$\{\{/);
    expect(script).toContain('"$FORMIC_PROMPT"');
  });
});

describe("including the job from .gitlab-ci.yml", () => {
  it("writes a CI file with only the include where the project has none", () => {
    const text = withRunnerInclude(null)!;
    expect(parse(text)).toEqual({ include: [{ local: GITLAB_RUNNER_PATH }] });
  });

  it("adds the include above a CI file that has none, keeping the rest as it was", () => {
    const current = "# our CI\ntest:\n  script: npm test\n";
    const text = withRunnerInclude(current)!;
    expect(text.endsWith(current)).toBe(true);
    expect(parse(text)).toEqual({ include: [{ local: GITLAB_RUNNER_PATH }], test: { script: "npm test" } });
  });

  it("adds to an include list, or turns a single include into one, comments kept", () => {
    const list = withRunnerInclude("include:\n  # shared\n  - project: acme/ci\n    file: node.yml\n")!;
    expect(list).toContain("# shared");
    expect(parse(list).include).toEqual([{ project: "acme/ci", file: "node.yml" }, { local: GITLAB_RUNNER_PATH }]);

    const single = withRunnerInclude("include: templates/base.yml\n")!;
    expect(parse(single).include).toEqual(["templates/base.yml", { local: GITLAB_RUNNER_PATH }]);
  });

  it("leaves a CI file that already includes it alone", () => {
    expect(withRunnerInclude(`include:\n  - local: ${GITLAB_RUNNER_PATH}\n`)).toBeNull();
  });
});

/** A mock repository that answers as gitlab.com would, for the runner's choices. */
class GitlabMock extends MockVcsClient {
  override readonly name = "gitlab" as "mock";
  prepared = 0;
  async prepareRunner(): Promise<void> {
    this.prepared++;
  }
}

describe("setting up a GitLab project", () => {
  let client: GitlabMock;

  beforeEach(() => {
    (globalThis as { __formicMemoryStore?: unknown }).__formicMemoryStore = undefined;
    MockVcsClient.reset();
    client = new GitlabMock("gitlab:acme/widgets");
    setVcs(client);
    vi.stubEnv("GITHUB_TOKEN", "ghp_test");
    resetEnvCache();
  });

  afterEach(() => {
    resetVcs();
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  const project = async () => ({ ...(await repository().defaultProject()), repoFullName: "gitlab:acme/widgets" });

  it("asks before opening anything", async () => {
    vi.stubEnv("GITLAB_TOKEN", "glpat_test");
    resetEnvCache();
    expect(await runnerSetup(await project())).toEqual({ state: "ask", plans: false });
    expect(client.prepared).toBe(0);
  });

  it("on yes, switches on the project's CI settings and opens one merge request with the job and its include", async () => {
    vi.stubEnv("GITLAB_TOKEN", "glpat_test");
    resetEnvCache();
    await client.commitFile("main", GITLAB_CI_PATH, "test:\n  script: npm test\n", "their CI");

    const setup = await runnerSetup(await project(), { approve: true });

    expect(setup).toMatchObject({ state: "waiting", update: false });
    expect(client.prepared).toBe(1);
    const branch = gitlabSetupBranch();
    expect(await client.readFile(GITLAB_RUNNER_PATH, branch)).toBe(gitlabRunnerConfig());
    expect(parse((await client.readFile(GITLAB_CI_PATH, branch))!)).toEqual({
      include: [{ local: GITLAB_RUNNER_PATH }],
      test: { script: "npm test" },
    });
    expect((await client.findPullRequest(branch))?.url).toBe(setup.state === "waiting" ? setup.setupUrl : "");
  });

  it("is ready, and runs the loop there, once the job is on the base branch", async () => {
    vi.stubEnv("GITLAB_TOKEN", "glpat_test");
    resetEnvCache();
    expect(await loopRunnerReady(client, "main")).toBe(false);
    await client.commitFile("main", GITLAB_RUNNER_PATH, gitlabRunnerConfig(), "merged");
    await client.commitFile("main", GITLAB_CI_PATH, withRunnerInclude(null)!, "merged");

    expect(await runnerSetup(await project())).toEqual({ state: "ready" });
    expect(await loopRunnerReady(client, "main")).toBe(true);
  });

  it("has nothing to set up without a GitLab token", async () => {
    expect(await runnerSetup(await project())).toEqual({ state: "ready" });
  });
});
