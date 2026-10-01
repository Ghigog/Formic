import type { BranchRun, CheckLog, CheckSummary, SecurityFacts, SecurityList } from "@/lib/vcs/types";

/**
 * What a sentinel is told beyond the code: facts GitHub already holds that no
 * amount of reading source would show. Each one is gathered for the roles
 * whose brief needs it (see `evidence` in the roster) and handed over as
 * plain text, so it costs one prompt section and no extra model calls.
 *
 * No server imports: everything here is formatting, and the gathering lives
 * in the service.
 */

/**
 * What a role can be given. `ci`, `deps` and `security` come from GitHub's
 * API; `imports`, `untested` and `a11y` are worked out from the code itself
 * (see ./analysis); `coverage`, `bundle`, `axe` and `screens` come from the
 * base branch's CI artifacts, when the project's CI uploads them.
 */
export type EvidenceKind =
  | "ci"
  | "deps"
  | "security"
  | "imports"
  | "untested"
  | "a11y"
  | "coverage"
  | "bundle"
  | "axe"
  | "screens";

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

/* ------------------------------------------------------------------ */
/* GitHub's security features                                         */
/* ------------------------------------------------------------------ */

/** Open security alerts and the guard rails around the base branch. */
export function securityEvidence(f: SecurityFacts, branch: string): string {
  const lines = ["GitHub's own security features:"];
  const list = <T>(label: string, l: SecurityList<T>, line: (t: T) => string) => {
    if (!l.ok) return lines.push(`- ${label}: ${l.reason}`);
    lines.push(`- ${label}: ${l.items.length} open`);
    for (const t of l.items.slice(0, 25)) lines.push(`  - ${line(t)}`);
    if (l.items.length > 25) lines.push(`  - and ${l.items.length - 25} more`);
  };
  list("Dependabot alerts", f.dependabot, (a) => `${a.severity}: ${a.package} (${a.ecosystem}, ${a.manifest}): ${a.summary}${a.fixedIn ? `; fixed in ${a.fixedIn}` : "; no fix yet"}`);
  list("Secret-scanning alerts", f.secrets, (a) => `${a.type}, since ${a.createdAt.slice(0, 10)}${a.pushProtectionBypassed ? ", pushed past push protection" : ""}`);
  list("Code-scanning alerts", f.codeScanning, (a) => `${a.severity}: ${a.rule} (${a.tool}) at ${a.path}${a.line ? `:${a.line}` : ""}`);
  lines.push(
    f.protection.ok
      ? `- ${branch} is ${f.protection.protected ? "protected" : "not protected"}${f.protection.requiredChecks.length ? `; required checks: ${f.protection.requiredChecks.join(", ")}` : f.protection.protected ? "; no required checks" : ""}`
      : `- Branch protection: ${f.protection.reason}`,
  );
  if (f.settings.ok) {
    const features = Object.entries(f.settings.features).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`);
    lines.push(`- Repository is ${f.settings.visibility}${features.length ? `; ${features.join(", ")}` : "; security settings not visible to this token"}`);
  } else {
    lines.push(`- Repository settings: ${f.settings.reason}`);
  }
  return cap(lines.join("\n"));
}

/* ------------------------------------------------------------------ */
/* CI artifacts                                                       */
/* ------------------------------------------------------------------ */

/**
 * Artifacts worth opening, by name. `sentinel-evidence` is Formic's own
 * convention (see docs/sentinels.md); the rest are what projects commonly
 * upload already.
 */
export const ARTIFACT_NAMES = /sentinel|coverage|bundle|axe|a11y|accessib|screenshot|playwright|lighthouse/i;

/** Files inside those artifacts worth keeping. */
export function artifactFileWanted(path: string, size: number): boolean {
  if (/\.(png|jpe?g|webp)$/i.test(path)) return size <= 1_500_000;
  return /\.json$/i.test(path) && size <= 5_000_000;
}

export interface ArtifactFacts {
  runUrl: string;
  coverage: string | null;
  bundle: string | null;
  axe: string | null;
  images: Array<{ name: string; mediaType: "image/png" | "image/jpeg" | "image/webp"; data: Buffer }>;
}

/** Sorts an artifact's files into what each role reads. */
export function readArtifacts(runUrl: string, files: Map<string, Buffer>): ArtifactFacts {
  const facts: ArtifactFacts = { runUrl, coverage: null, bundle: null, axe: null, images: [] };
  const axe: AxeResult[] = [];
  for (const [path, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const image = /\.(png|jpe?g|webp)$/i.exec(path)?.[1]?.toLowerCase();
    if (image) {
      facts.images.push({ name: path, mediaType: image === "png" ? "image/png" : image === "webp" ? "image/webp" : "image/jpeg", data: bytes });
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(bytes.toString("utf8"));
    } catch {
      continue;
    }
    if (/coverage-summary\.json$/.test(path)) facts.coverage ??= coverageText(json);
    else if (/bundle[^/]*\.json$/.test(path)) facts.bundle ??= bundleText(json);
    else for (const r of Array.isArray(json) ? json : [json]) if (isAxe(r)) axe.push(r);
  }
  if (axe.length) facts.axe = axeText(axe);
  return facts;
}

type Pct = { total: number; covered: number; pct: number | "Unknown" };
type CoverageRow = { lines?: Pct; statements?: Pct; functions?: Pct; branches?: Pct };

/** Istanbul's json-summary, the format vitest, jest and nyc all write. */
function coverageText(json: unknown): string | null {
  if (!json || typeof json !== "object" || !("total" in json)) return null;
  const all = json as Record<string, CoverageRow>;
  const pct = (p?: Pct) => (p && typeof p.pct === "number" ? `${p.pct.toFixed(1)}%` : "?");
  const t = all.total!;
  const out = [
    `Coverage: lines ${pct(t.lines)}, branches ${pct(t.branches)}, functions ${pct(t.functions)}, statements ${pct(t.statements)}.`,
  ];
  const files = Object.entries(all)
    .filter(([k, v]) => k !== "total" && v.lines && v.lines.total > 0)
    .map(([k, v]) => ({ path: k.replace(/^.*?\/(src|app|lib|packages)\//, "$1/"), lines: v.lines!, branches: v.branches }));
  const uncovered = (f: { lines: Pct }) => f.lines.total - f.lines.covered;
  const worst = files.filter((f) => f.lines.total >= 20 && uncovered(f) > 0).sort((a, b) => uncovered(b) - uncovered(a));
  if (worst.length) {
    out.push("Files with the most uncovered lines:");
    for (const f of worst.slice(0, 30)) {
      out.push(`- ${f.path}: ${pct(f.lines)} of ${f.lines.total} lines, branches ${pct(f.branches)}`);
    }
  }
  return out.join("\n");
}

interface Bundle {
  totalBytes?: number;
  gzipBytes?: number;
  chunks?: Array<{ file: string; bytes: number; gzip?: number }>;
  routes?: Array<{ route: string; bytes: number; gzip?: number }>;
}

/** Formic's `bundle.json`: the client JavaScript a build ships (see docs/sentinels.md). */
function bundleText(json: unknown): string | null {
  const b = json as Bundle;
  if (!b || typeof b.totalBytes !== "number") return null;
  const kb = (n?: number) => (n === undefined ? "?" : `${(n / 1024).toFixed(1)} kB`);
  const out = [`Client JavaScript shipped: ${kb(b.totalBytes)}, ${kb(b.gzipBytes)} gzipped, in ${b.chunks?.length ?? "?"} chunks.`];
  if (b.routes?.length) {
    out.push("Per route, first load:");
    for (const r of b.routes.slice(0, 30)) out.push(`- ${r.route}: ${kb(r.bytes)} (${kb(r.gzip)} gzipped)`);
  }
  if (b.chunks?.length) {
    out.push("Largest chunks:");
    for (const c of [...b.chunks].sort((x, y) => y.bytes - x.bytes).slice(0, 15)) out.push(`- ${c.file}: ${kb(c.bytes)} (${kb(c.gzip)} gzipped)`);
  }
  return out.join("\n");
}

interface AxeResult {
  url?: string;
  violations: Array<{ id: string; impact: string | null; help: string; nodes: Array<{ target: unknown[] }> }>;
  passes?: unknown[];
}

function isAxe(r: unknown): r is AxeResult {
  return !!r && typeof r === "object" && Array.isArray((r as AxeResult).violations);
}

/** axe-core results, the format every axe integration writes. */
function axeText(results: AxeResult[]): string {
  const out = [`axe-core scans of ${results.length} page${results.length === 1 ? "" : "s"} in a real browser:`];
  for (const r of results) {
    out.push(`- ${r.url ?? "a page"}: ${r.violations.length} rules violated${r.passes ? `, ${r.passes.length} passed` : ""}`);
    for (const v of r.violations.slice(0, 15)) {
      const where = v.nodes.slice(0, 3).map((n) => String(n.target?.[0] ?? "?")).join(", ");
      out.push(`  - ${v.impact ?? "unknown"}: ${v.id}: ${v.help} (${v.nodes.length} elements, e.g. ${where})`);
    }
  }
  return cap(out.join("\n"));
}
