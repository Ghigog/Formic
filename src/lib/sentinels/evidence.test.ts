import { describe, expect, it } from "vitest";
import type { BranchRun } from "@/lib/vcs/types";
import { ciEvidence, dependencyEvidence, flakyWorkflows, readArtifacts, securityEvidence } from "./evidence";

const run = (over: Partial<BranchRun>): BranchRun => ({
  name: "CI",
  sha: "aaa",
  status: "completed",
  conclusion: "success",
  attempt: 1,
  startedAt: "2026-09-30T10:00:00Z",
  updatedAt: "2026-09-30T10:06:00Z",
  url: "https://github.com/o/r/actions/runs/1",
  ...over,
});

describe("flakyWorkflows", () => {
  it("names a workflow that failed and passed on the same commit", () => {
    expect(flakyWorkflows([run({ conclusion: "failure" }), run({}), run({ name: "Lint" })])).toEqual(["CI"]);
  });

  it("names a workflow that passed only on a re-run", () => {
    expect(flakyWorkflows([run({ name: "E2E", attempt: 2 })])).toEqual(["E2E"]);
  });

  it("does not call a fix on a later commit flaky", () => {
    expect(flakyWorkflows([run({ conclusion: "failure" }), run({ sha: "bbb" })])).toEqual([]);
  });
});

describe("ciEvidence", () => {
  it("reports the head's checks, what failed and how the runs went", () => {
    const text = ciEvidence({
      branch: "main",
      sha: "abcdef0123",
      checks: [
        { id: 1, name: "test", status: "completed", conclusion: "failure", detailsUrl: null },
        { id: 2, name: "lint", status: "completed", conclusion: "success", detailsUrl: null },
      ],
      failures: [
        { name: "test", summary: "1 failed", annotations: [{ path: "src/a.test.ts", line: 4, message: "expected 1\nreceived 2" }] },
      ],
      runs: [run({ conclusion: "failure" }), run({}), run({ name: "Deploy", updatedAt: "2026-09-30T10:02:00Z" })],
    });
    expect(text).toContain("CI on main at abcdef0:");
    expect(text).toContain("- test: failure");
    expect(text).toContain("src/a.test.ts:4: expected 1");
    expect(text).not.toContain("received 2");
    expect(text).toContain("- CI: 1 passed, 1 failed, 0 other; median 6.0 min");
    expect(text).toContain("- Deploy: 1 passed, 0 failed, 0 other; median 2.0 min");
    expect(text).toContain("Flaky: CI");
  });

  it("says plainly when there is nothing to report", () => {
    const text = ciEvidence({ branch: "main", sha: null, checks: [], failures: [], runs: [] });
    expect(text).toContain("No checks ran on the latest commit.");
    expect(text).toContain("No finished Actions runs on this branch.");
  });
});

describe("dependencyEvidence", () => {
  const manifest = JSON.stringify({
    dependencies: { next: "^16.0.0", gpl: "1.0.0" },
    devDependencies: { vitest: "^4.0.0" },
  });
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { name: "app" },
      "node_modules/next": { version: "16.3.6", license: "MIT" },
      "node_modules/gpl": { version: "1.0.0", license: "GPL-3.0-only", deprecated: "use x" },
      "node_modules/dual": { version: "2.0.0", license: "(MIT OR GPL-2.0)" },
      "node_modules/next/node_modules/inner": { version: "0.1.0" },
      "node_modules/vitest": { version: "4.1.0", license: "MIT", dev: true },
    },
  });

  it("joins what is declared to what resolves, with licences", () => {
    const text = dependencyEvidence(manifest, lock, "package-lock.json");
    expect(text).toContain("- next ^16.0.0, resolves to 16.3.6, MIT");
    expect(text).toContain("- gpl 1.0.0, resolves to 1.0.0, GPL-3.0-only, DEPRECATED: use x");
    expect(text).toContain("Dev dependencies:\n- vitest ^4.0.0, resolves to 4.1.0, MIT");
    expect(text).toContain("resolves 5 packages, 4 of them shipped (not dev-only), 1 deprecated.");
  });

  it("lists shipped packages outside the permissive licences, and leaves dev ones out", () => {
    const text = dependencyEvidence(manifest, lock, "package-lock.json");
    expect(text).toContain("- GPL-3.0-only: gpl@1.0.0");
    expect(text).toContain("- no licence declared: inner@0.1.0");
    expect(text).not.toContain("(MIT OR GPL-2.0):");
    expect(text).not.toContain("vitest@");
  });

  it("says why it cannot resolve versions", () => {
    expect(dependencyEvidence(manifest, null, null)).toContain("No lockfile");
    expect(dependencyEvidence(manifest, null, "pnpm-lock.yaml")).toContain("pnpm-lock.yaml, which is not parsed here");
    expect(dependencyEvidence(manifest, null, "package-lock.json")).toContain("could not be read");
    expect(dependencyEvidence(null, null, null)).toContain("No package.json");
  });
});

describe("readArtifacts", () => {
  const json = (v: unknown) => Buffer.from(JSON.stringify(v));
  const files = new Map<string, Buffer>([
    [
      "sentinel-evidence-coverage/coverage-summary.json",
      json({
        total: { lines: { total: 100, covered: 80, pct: 80 }, branches: { total: 10, covered: 5, pct: 50 }, functions: { total: 1, covered: 1, pct: 100 }, statements: { total: 1, covered: 1, pct: 100 } },
        "/home/runner/work/r/r/src/lib/vcs/github.ts": { lines: { total: 400, covered: 0, pct: 0 }, branches: { total: 1, covered: 0, pct: 0 } },
        "/home/runner/work/r/r/src/lib/ok.ts": { lines: { total: 50, covered: 50, pct: 100 } },
      }),
    ],
    ["sentinel-evidence/bundle.json", json({ totalBytes: 512_000, gzipBytes: 160_000, chunks: [{ file: "a.js", bytes: 300_000, gzip: 90_000 }] })],
    [
      "sentinel-evidence/axe/board-light.json",
      json({ url: "/ (light)", passes: [1, 2], violations: [{ id: "color-contrast", impact: "serious", help: "Elements must meet contrast", nodes: [{ target: [".chip"] }] }] }),
    ],
    ["sentinel-evidence/screens/board-light.png", Buffer.from([0x89, 0x50])],
  ]);

  it("sorts coverage, bundle, axe and screenshots out of the artifacts", () => {
    const a = readArtifacts("https://run", files);
    expect(a.coverage).toContain("Coverage: lines 80.0%, branches 50.0%");
    expect(a.coverage).toContain("- src/lib/vcs/github.ts: 0.0% of 400 lines");
    expect(a.coverage).not.toContain("ok.ts");
    expect(a.bundle).toContain("Client JavaScript shipped: 500.0 kB, 156.3 kB gzipped, in 1 chunks.");
    expect(a.axe).toContain("- / (light): 1 rules violated, 2 passed");
    expect(a.axe).toContain("serious: color-contrast: Elements must meet contrast (1 elements, e.g. .chip)");
    expect(a.images).toEqual([{ name: "sentinel-evidence/screens/board-light.png", mediaType: "image/png", data: Buffer.from([0x89, 0x50]) }]);
  });
});

describe("securityEvidence", () => {
  it("lists open alerts and says which features it could not see", () => {
    const text = securityEvidence(
      {
        dependabot: { ok: true, items: [{ package: "next", ecosystem: "npm", severity: "high", summary: "SSRF", manifest: "package-lock.json", fixedIn: "16.3.7" }] },
        secrets: { ok: false, reason: "not available to this token, or not turned on for the repository (403)" },
        codeScanning: { ok: true, items: [] },
        protection: { ok: true, protected: true, requiredChecks: ["test", "lint"] },
        settings: { ok: true, visibility: "private", features: {} },
      },
      "main",
    );
    expect(text).toContain("- Dependabot alerts: 1 open\n  - high: next (npm, package-lock.json): SSRF; fixed in 16.3.7");
    expect(text).toContain("- Secret-scanning alerts: not available to this token");
    expect(text).toContain("- Code-scanning alerts: 0 open");
    expect(text).toContain("- main is protected; required checks: test, lint");
    expect(text).toContain("- Repository is private; security settings not visible to this token");
  });
});
