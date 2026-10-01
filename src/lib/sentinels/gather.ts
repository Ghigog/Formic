import type { VcsClient } from "@/lib/vcs/types";
import { ciEvidence, dependencyEvidence, type EvidenceKind } from "./evidence";

/**
 * Collects the evidence a sentinel's role asks for, one section per kind.
 * A section GitHub will not give (no Actions, a token without access) still
 * comes back, saying so, so the sentinel reports the gap instead of
 * inventing a reason for it.
 */
export async function gatherEvidence(
  client: VcsClient,
  branch: string,
  files: string[],
  kinds: EvidenceKind[] = [],
): Promise<string[]> {
  return Promise.all(
    kinds.map(async (kind) => {
      try {
        return kind === "ci" ? await ci(client, branch) : await deps(client, branch, files);
      } catch (e) {
        const what = kind === "ci" ? "CI results" : "The dependency list";
        return `${what} could not be read from GitHub: ${e instanceof Error ? e.message : String(e)}`;
      }
    }),
  );
}

async function ci(client: VcsClient, branch: string): Promise<string> {
  const sha = await client.branchHead(branch);
  const [checks, runs] = await Promise.all([
    sha ? client.checksFor(sha) : Promise.resolve([]),
    client.branchRuns(branch),
  ]);
  const red = checks.filter((c) => c.conclusion === "failure" || c.conclusion === "timed_out").slice(0, 5);
  const failures = await Promise.all(
    red.map((c) => client.checkLog(c.id).catch(() => ({ name: c.name, summary: "", annotations: [] }))),
  );
  return ciEvidence({ branch, sha, checks, failures, runs });
}

const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"];

async function deps(client: VcsClient, branch: string, files: string[]): Promise<string> {
  const present = new Set(files);
  if (!present.has("package.json")) return dependencyEvidence(null, null, null);
  const lockName = LOCKFILES.find((f) => present.has(f)) ?? null;
  const npmLock = lockName === "package-lock.json" || lockName === "npm-shrinkwrap.json";
  const [manifest, lockfile] = await Promise.all([
    client.readFile("package.json", branch),
    npmLock ? client.readFile(lockName, branch).catch(() => null) : Promise.resolve(null),
  ]);
  return dependencyEvidence(manifest, lockfile || null, lockName);
}
