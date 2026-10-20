import { parse } from "yaml";

/**
 * Whether a GitHub Actions workflow reports checks on a pull request's head
 * into `baseBranch`. One that runs only by hand, on a schedule or on pushes to
 * the base never does, and a head waiting for it waits for good.
 *
 * Anything Formic cannot read counts as yes: waiting is the safe side.
 */
export function runsOnPullRequests(source: string, baseBranch: string): boolean {
  let doc: unknown;
  try {
    doc = parse(source);
  } catch {
    return true;
  }
  if (!isRecord(doc)) return true;
  // YAML 1.1 readers turn a bare `on` into true; be ready for either.
  const on = "on" in doc ? doc.on : doc["true"];
  if (on === undefined || on === null) return true;

  if (typeof on === "string") return triggerRuns(on, null, baseBranch);
  if (Array.isArray(on)) return on.some((e) => typeof e !== "string" || triggerRuns(e, null, baseBranch));
  if (isRecord(on)) return Object.entries(on).some(([event, config]) => triggerRuns(event, config, baseBranch));
  return true;
}

function triggerRuns(event: string, config: unknown, baseBranch: string): boolean {
  if (event === "pull_request" || event === "pull_request_target") return true;
  if (event !== "push") return false;
  if (!isRecord(config)) return true;
  const branches = config.branches;
  if (branches === undefined) {
    // Only tag filters: GitHub runs it for tags and never for a branch.
    if (!("branches-ignore" in config) && ("tags" in config || "tags-ignore" in config)) return false;
    return true;
  }
  // Pushes to the base alone never land on a pull request's head.
  const list = Array.isArray(branches) ? branches : [branches];
  return list.some((b) => b !== baseBranch);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
