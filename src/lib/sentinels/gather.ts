import type { Snapshot, VcsClient } from "@/lib/vcs/types";
import { a11yEvidence, aliasesFrom, importEvidence, importGraph, untestedEvidence } from "./analysis";
import {
  ARTIFACT_NAMES,
  artifactFileWanted,
  ciEvidence,
  dependencyEvidence,
  readArtifacts,
  securityEvidence,
  type ArtifactFacts,
  type EvidenceKind,
} from "./evidence";

/**
 * Collects the evidence a sentinel's role asks for, one section per kind.
 * A section GitHub will not give (no Actions, a token without access) still
 * comes back, saying so, so the sentinel reports the gap instead of
 * inventing a reason for it.
 */

export interface Evidence {
  sections: string[];
  /** Screenshots from CI, for the roles that judge what a page looks like. */
  images: ArtifactFacts["images"];
}

export interface GatherInput {
  client: VcsClient;
  branch: string;
  files: string[];
  kinds?: EvidenceKind[];
  /** The repository's text, when it could be downloaded whole. */
  snapshot?: Snapshot | null;
}

const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"];
const FROM_CODE: EvidenceKind[] = ["imports", "untested", "a11y"];
const FROM_ARTIFACTS: EvidenceKind[] = ["coverage", "bundle", "axe", "screens"];

/** Images per audit, and bytes in all: enough to see a page, not to fill the prompt. */
const MAX_IMAGES = 10;
const IMAGE_BUDGET = 8_000_000;

export async function gatherEvidence({ client, branch, files, kinds = [], snapshot }: GatherInput): Promise<Evidence> {
  const want = new Set(kinds);
  const fail = (what: string) => (e: unknown) => `${what} could not be read from GitHub: ${e instanceof Error ? e.message : String(e)}`;

  // One download serves every artifact kind the role asks for.
  const artifacts = FROM_ARTIFACTS.some((k) => want.has(k))
    ? client.artifacts(branch, ARTIFACT_NAMES, artifactFileWanted, 40_000_000).then(
        (a) => (a ? readArtifacts(a.runUrl, a.files) : null),
        (e: unknown) => fail("CI artifacts")(e),
      )
    : Promise.resolve(null);

  const texts = snapshot ? textsOf(snapshot) : null;
  const graph = texts && (want.has("imports") || want.has("untested")) ? importGraph(texts, aliasesFrom(texts.get("tsconfig.json") ?? texts.get("jsconfig.json"))) : null;
  const noSnapshot = "The repository could not be downloaded whole, so this was not worked out.";

  const sections = await Promise.all(
    kinds.map(async (kind): Promise<string> => {
      if (kind === "ci") return ci(client, branch).catch(fail("CI results"));
      if (kind === "deps") return deps(client, branch, files, snapshot).catch(fail("The dependency list"));
      if (kind === "security") return client.security(branch).then((f) => securityEvidence(f, branch), fail("Security alerts"));
      if (FROM_CODE.includes(kind)) {
        if (!texts) return `${label(kind)}: ${noSnapshot}`;
        if (kind === "imports") return importEvidence(texts, graph!);
        if (kind === "untested") return untestedEvidence(files, texts, graph!);
        return a11yEvidence(texts);
      }
      const a = await artifacts;
      if (typeof a === "string") return a;
      if (!a) return `${label(kind)}: no finished run on ${branch} uploaded an artifact named like ${ARTIFACT_NAMES.source}, so there is none. docs/sentinels.md says what to upload.`;
      if (kind === "screens") {
        return a.images.length
          ? `${Math.min(a.images.length, MAX_IMAGES)} screenshots from CI (${a.runUrl}) are attached: ${a.images.slice(0, MAX_IMAGES).map((i) => i.name).join(", ")}.`
          : `${label(kind)}: the CI artifacts at ${a.runUrl} hold no screenshots.`;
      }
      const text = a[kind as "coverage" | "bundle" | "axe"];
      return text ? `From CI artifacts (${a.runUrl}):\n${text}` : `${label(kind)}: the CI artifacts at ${a.runUrl} hold none.`;
    }),
  );

  let images: Evidence["images"] = [];
  if (want.has("screens")) {
    const a = await artifacts;
    if (a && typeof a !== "string") {
      let left = IMAGE_BUDGET;
      images = a.images.filter((i) => (left -= i.data.length) >= 0).slice(0, MAX_IMAGES);
    }
  }
  return { sections, images };
}

function label(kind: EvidenceKind): string {
  return {
    ci: "CI results",
    deps: "Dependencies",
    security: "Security alerts",
    imports: "Import map",
    untested: "Untested code",
    a11y: "Accessibility pattern checks",
    coverage: "Coverage",
    bundle: "Bundle size",
    axe: "Accessibility scans",
    screens: "Screenshots",
  }[kind];
}

/** The snapshot's text files, decoded. */
export function textsOf(snapshot: Snapshot): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, bytes] of snapshot.files) {
    if (bytes.includes(0)) continue;
    out.set(path, bytes.toString("utf8"));
  }
  return out;
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

async function deps(client: VcsClient, branch: string, files: string[], snapshot?: Snapshot | null): Promise<string> {
  const present = new Set(files);
  if (!present.has("package.json")) return dependencyEvidence(null, null, null);
  const lockName = LOCKFILES.find((f) => present.has(f)) ?? null;
  const npmLock = lockName === "package-lock.json" || lockName === "npm-shrinkwrap.json";
  const read = (path: string) =>
    snapshot?.files.has(path) ? Promise.resolve(snapshot.files.get(path)!.toString("utf8")) : client.readFile(path, branch);
  const [manifest, lockfile] = await Promise.all([
    read("package.json"),
    npmLock ? read(lockName).catch(() => null) : Promise.resolve(null),
  ]);
  return dependencyEvidence(manifest, lockfile || null, lockName);
}
