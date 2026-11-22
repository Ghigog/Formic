import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/fixtures/board", () => ({ FIXTURE_CARDS: [], FIXTURE_TICKET_DETAILS: {} }));

const { repository } = await import("@/lib/db");
const { lintRuleIds, recordLintFailures, recurringLint, recurringLintFor } = await import("./recurring-lint");

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
});

const lint = (message: string) => ({ name: "lint-and-android-test-compile", summary: "", annotations: [{ message }] });

describe("lintRuleIds", () => {
  it("reads Android lint's trailing id and ESLint's rule names", () => {
    expect(
      lintRuleIds({
        summary: "Lint found 2 errors",
        annotations: [
          { message: "Use the KTX extension function instead [UseKtx]" },
          { message: "'x' is defined but never used (@typescript-eslint/no-unused-vars)" },
          { message: "Unexpected console  no-console" },
          { message: "Plain sentence with no rule." },
        ],
      }).sort(),
    ).toEqual(["@typescript-eslint/no-unused-vars", "UseKtx", "no-console"]);
  });
});

describe("recurringLint", () => {
  async function setup() {
    const project = await repository().defaultProject();
    return { projectId: project.id, repoFullName: project.repoFullName };
  }

  it("lists a rule failing on two distinct pull requests, with them", async () => {
    const { projectId, repoFullName } = await setup();
    await recordLintFailures(projectId, "t1", 723, [lint("a [UseKtx]")]);
    await recordLintFailures(projectId, "t2", 724, [lint("a [UseKtx]"), lint("b [OnlyOnce]")]);
    await recordLintFailures(projectId, "t2", 724, [lint("a [UseKtx]")]);
    expect(await recurringLint(repoFullName)).toEqual([{ rule: "UseKtx", pulls: [723, 724] }]);
    expect(await recurringLintFor(projectId)).toEqual(["UseKtx (#723, #724)"]);
  });

  it("does not count one pull request twice, or checks that are not lint", async () => {
    const { projectId, repoFullName } = await setup();
    await recordLintFailures(projectId, "t1", 5, [lint("a [UseKtx]")]);
    await recordLintFailures(projectId, "t1", 5, [lint("a [UseKtx]")]);
    await recordLintFailures(projectId, "t1", 6, [{ ...lint("a [UseKtx]"), name: "unit tests" }]);
    expect(await recurringLint(repoFullName)).toEqual([]);
  });

  it("ignores failures older than 30 days", async () => {
    const { projectId, repoFullName } = await setup();
    await recordLintFailures(projectId, "t1", 1, [lint("a [UseKtx]")]);
    await recordLintFailures(projectId, "t1", 2, [lint("a [UseKtx]")]);
    expect(await recurringLint(repoFullName, Date.now() + 31 * 24 * 60 * 60 * 1000)).toEqual([]);
  });
});
