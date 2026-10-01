import type { BranchRun, CheckLog, CheckSummary } from "@/lib/vcs/types";

/**
 * What a sentinel is told beyond the code: facts GitHub already holds that no
 * amount of reading source would show. Each one is gathered for the roles
 * whose brief needs it (see `evidence` in the roster) and handed over as
 * plain text, so it costs one prompt section and no extra model calls.
 *
 * No server imports: everything here is formatting, and the gathering lives
 * in the service.
 */

export type EvidenceKind = "ci" | "deps";

/** Characters per section, so evidence never crowds out the code itself. */
const SECTION_CAP = 12_000;

export interface CiInput {
  branch: string;
  /** The branch head, or null when the branch has no commits we can see. */
  sha: string | null;
  checks: CheckSummary[];
  /** The failed checks' logs, in the order of `checks`. */
  failures: CheckLog[];
  runs: BranchRun[];
}

/** The base branch's CI, as it stands now and over its recent runs. */
export function ciEvidence(ci: CiInput): string {
  const lines = [`CI on ${ci.branch}${ci.sha ? ` at ${ci.sha.slice(0, 7)}` : ""}:`];

  if (ci.checks.length === 0) {
    lines.push("No checks ran on the latest commit.");
  } else {
    for (const c of ci.checks) lines.push(`- ${c.name}: ${c.status === "completed" ? (c.conclusion ?? "unknown") : c.status}`);
  }

  for (const f of ci.failures) {
    lines.push("", `Failed check "${f.name}":`);
    if (f.summary) lines.push(f.summary.slice(0, 1500));
    for (const a of f.annotations.slice(0, 10)) {
      lines.push(`  ${a.path}${a.line ? `:${a.line}` : ""}: ${a.message.split("\n")[0]}`);
    }
  }

  const done = ci.runs.filter((r) => r.status === "completed");
  if (done.length > 0) {
    lines.push("", `The last ${done.length} finished runs on ${ci.branch}, by workflow:`);
    const byName = new Map<string, BranchRun[]>();
    for (const r of done) byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
    for (const [name, runs] of byName) {
      const passed = runs.filter((r) => r.conclusion === "success").length;
      const failed = runs.filter((r) => r.conclusion === "failure").length;
      const minutes = median(runs.map(durationMinutes).filter((m): m is number => m !== null));
      lines.push(
        `- ${name}: ${passed} passed, ${failed} failed, ${runs.length - passed - failed} other` +
          (minutes !== null ? `; median ${minutes.toFixed(1)} min` : ""),
      );
    }
    const flaky = flakyWorkflows(done);
    lines.push(
      flaky.length
        ? `Flaky: ${flaky.join(", ")} both failed and passed on the same commit, or passed only on a re-run.`
        : "No workflow both failed and passed on the same commit.",
    );
  } else {
    lines.push("", "No finished Actions runs on this branch.");
  }

  return cap(lines.join("\n"));
}

/** Workflows that gave two answers for one commit: the plainest sign of a flaky test. */
export function flakyWorkflows(runs: BranchRun[]): string[] {
  const seen = new Map<string, Set<string | null>>();
  const flaky = new Set<string>();
  for (const r of runs) {
    if (r.attempt > 1 && r.conclusion === "success") flaky.add(r.name);
    const key = `${r.name}@${r.sha}`;
    const outcomes = seen.get(key) ?? new Set();
    outcomes.add(r.conclusion);
    seen.set(key, outcomes);
    if (outcomes.has("success") && outcomes.has("failure")) flaky.add(r.name);
  }
  return [...flaky].sort();
}

function durationMinutes(r: BranchRun): number | null {
  const ms = Date.parse(r.updatedAt) - Date.parse(r.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms / 60_000 : null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Licences a company's lawyers wave through. Anything else is listed by name,
 * which is where Legal and SecOps should look first.
 */
const PERMISSIVE = new Set([
  "MIT",
  "ISC",
  "0BSD",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
  "Python-2.0",
  "CC-BY-4.0",
  "MIT-0",
]);

interface LockPackage {
  version?: string;
  license?: string | { type?: string };
  dev?: boolean;
  deprecated?: string;
}

/**
 * The project's dependencies from package.json and, when there is one, the
 * npm lockfile: what is declared, what actually resolves, and under which
 * licences. Lockfiles are kept out of what a sentinel reads because they are
 * too long to read, so this is the only way their facts arrive.
 */
export function dependencyEvidence(manifest: string | null, lockfile: string | null, lockName: string | null): string {
  if (!manifest) return "No package.json at the repository root, so no dependency list.";

  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(manifest);
  } catch {
    return "package.json at the repository root is not valid JSON.";
  }

  let packages: Record<string, LockPackage> | null = null;
  if (lockfile) {
    try {
      const lock = JSON.parse(lockfile) as { packages?: Record<string, LockPackage> };
      packages = lock.packages ?? null;
    } catch {
      packages = null;
    }
  }

  const resolved = (name: string) => packages?.[`node_modules/${name}`];
  const declared = (deps: Record<string, string> | undefined) =>
    Object.entries(deps ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, range]) => {
        const p = resolved(name);
        const parts = [`${name} ${range}`];
        if (p?.version) parts.push(`resolves to ${p.version}`);
        const licence = licenceOf(p);
        if (licence) parts.push(licence);
        if (p?.deprecated) parts.push(`DEPRECATED: ${p.deprecated}`);
        return `- ${parts.join(", ")}`;
      });

  const lines = ["Dependencies declared in package.json:", ...declared(pkg.dependencies)];
  const dev = declared(pkg.devDependencies);
  if (dev.length) lines.push("", "Dev dependencies:", ...dev);

  if (!packages) {
    lines.push(
      "",
      lockName && /^(package-lock|npm-shrinkwrap)\.json$/.test(lockName)
        ? `${lockName} could not be read (it may be over GitHub's 1 MB file limit), so resolved versions and licences are unknown.`
        : lockName
          ? `The lockfile is ${lockName}, which is not parsed here, so resolved versions and licences are unknown.`
          : "No lockfile, so installs are not reproducible and resolved versions are unknown.",
    );
    return cap(lines.join("\n"));
  }

  const installed = Object.entries(packages).filter(([path]) => path.startsWith("node_modules/"));
  const byLicence = new Map<string, string[]>();
  let deprecated = 0;
  for (const [path, p] of installed) {
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    const licence = licenceOf(p) ?? "no licence declared";
    if (!p.dev) byLicence.set(licence, [...(byLicence.get(licence) ?? []), `${name}@${p.version ?? "?"}`]);
    if (p.deprecated) deprecated += 1;
  }

  const prod = installed.filter(([, p]) => !p.dev).length;
  lines.push("", `${lockName} resolves ${installed.length} packages, ${prod} of them shipped (not dev-only), ${deprecated} deprecated.`);
  const tally = [...byLicence.entries()].sort((a, b) => b[1].length - a[1].length);
  lines.push("Licences of shipped packages: " + tally.map(([l, names]) => `${l} ${names.length}`).join(", ") + ".");
  const flagged = tally.filter(([l]) => !isPermissive(l));
  if (flagged.length) {
    lines.push("Shipped packages outside the common permissive licences:");
    for (const [l, names] of flagged) lines.push(`- ${l}: ${names.slice(0, 15).join(", ")}${names.length > 15 ? `, and ${names.length - 15} more` : ""}`);
  } else {
    lines.push("Every shipped package declares a common permissive licence.");
  }

  return cap(lines.join("\n"));
}

function licenceOf(p: LockPackage | undefined): string | null {
  if (!p?.license) return null;
  return typeof p.license === "string" ? p.license : (p.license.type ?? null);
}

/** "MIT", "(MIT OR Apache-2.0)" and the like; an AND with anything else is not. */
function isPermissive(licence: string): boolean {
  const ids = licence.replace(/[()]/g, "").split(/\s+(?:OR|AND)\s+/);
  if (/\sOR\s/.test(licence) && !/\sAND\s/.test(licence)) return ids.some((id) => PERMISSIVE.has(id));
  return ids.every((id) => PERMISSIVE.has(id));
}

function cap(text: string): string {
  return text.length > SECTION_CAP ? `${text.slice(0, SECTION_CAP)}\n… (trimmed)` : text;
}
