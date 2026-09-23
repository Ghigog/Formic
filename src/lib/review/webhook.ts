import { createHmac, timingSafeEqual } from "node:crypto";

import {
  RUNNER_WORKFLOW_NAME,
  RUNNER_WORKFLOW_PATH,
  parseRunTitle,
  type RunnerMode,
} from "@/lib/runner/workflow";

/**
 * The GitHub webhook boundary.
 *
 * Two jobs, both of which are security properties rather than conveniences:
 * proving a delivery came from GitHub, and reducing it to an idempotency key.
 * Deliberately free of I/O so both are testable without a server.
 */

/**
 * Constant-time comparison of the `X-Hub-Signature-256` header against a
 * signature computed over the raw body. The raw body matters: re-serialising
 * parsed JSON changes bytes and every signature stops matching.
 */
export function verifySignature(
  rawBody: string,
  header: string | null,
  secret: string,
): boolean {
  if (!header) return false;

  const expected = `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
  const a = Buffer.from(header, "utf8");
  const b = Buffer.from(expected, "utf8");

  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length; compare the lengths first and keep the comparison constant-time.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type WebhookSignal =
  | {
      kind: "ci";
      prNumber: number;
      headSha: string;
      checkName: string;
      /** Keyed on (pull request, head sha, check) — not on the delivery id. */
      key: string;
    }
  | { kind: "merged"; prNumber: number; key: string }
  | {
      /** A CLI agent's run in the repository's Actions finished. */
      kind: "runner";
      job: string;
      mode: RunnerMode;
      conclusion: string;
      url: string | null;
      key: string;
    };

interface PullRef {
  number: number;
}

function pullNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((p) => (p as PullRef)?.number)
    .filter((n): n is number => typeof n === "number");
}

function ciSignals(
  prs: number[],
  headSha: string,
  checkName: string,
): WebhookSignal[] {
  if (!headSha) return [];
  return prs.map((prNumber) => ({
    kind: "ci" as const,
    prNumber,
    headSha,
    checkName,
    key: `${prNumber}:${headSha}:${checkName}`,
  }));
}

/**
 * Turns a delivery into the signals worth acting on, or nothing.
 *
 * Only completed results count. An in-progress check tells us nothing we
 * cannot re-read, and reacting to every intermediate state is how a fix loop
 * ends up racing itself.
 */
export function interpret(event: string, payload: unknown): WebhookSignal[] {
  const body = payload as Record<string, unknown>;
  const action = body.action as string | undefined;

  switch (event) {
    case "check_run": {
      const run = body.check_run as Record<string, unknown> | undefined;
      if (!run || action !== "completed") return [];
      return ciSignals(
        pullNumbers(run.pull_requests),
        String(run.head_sha ?? ""),
        String(run.name ?? "check"),
      );
    }

    case "check_suite": {
      const suite = body.check_suite as Record<string, unknown> | undefined;
      if (!suite || action !== "completed") return [];
      return ciSignals(
        pullNumbers(suite.pull_requests),
        String(suite.head_sha ?? ""),
        `suite:${suite.id ?? "unknown"}`,
      );
    }

    case "workflow_run": {
      const run = body.workflow_run as Record<string, unknown> | undefined;
      if (!run || action !== "completed") return [];
      // Formic's own runner is not CI. Its result is the agent's work.
      // Known by its file: a run's `name` is its run-name, the per-run
      // title, not the workflow's name.
      const path = String(run.path ?? "");
      if (
        path === RUNNER_WORKFLOW_PATH ||
        path.startsWith(`${RUNNER_WORKFLOW_PATH}@`) ||
        run.name === RUNNER_WORKFLOW_NAME
      ) {
        const parsed = parseRunTitle(String(run.display_title ?? ""));
        if (!parsed) return [];
        return [
          {
            kind: "runner",
            job: parsed.job,
            mode: parsed.mode,
            conclusion: String(run.conclusion ?? "failure"),
            url: typeof run.html_url === "string" ? run.html_url : null,
            key: `runner:${parsed.job}:${String(run.id ?? "")}`,
          },
        ];
      }
      return ciSignals(
        pullNumbers(run.pull_requests),
        String(run.head_sha ?? ""),
        `workflow:${run.name ?? run.id ?? "unknown"}`,
      );
    }

    case "pull_request": {
      const pull = body.pull_request as Record<string, unknown> | undefined;
      if (!pull || action !== "closed" || pull.merged !== true) return [];
      const prNumber = Number(pull.number);
      if (!Number.isFinite(prNumber)) return [];
      // Someone merged it by hand. The card should follow reality rather than
      // wait for a merge the platform is no longer going to perform.
      return [
        {
          kind: "merged",
          prNumber,
          key: `${prNumber}:merged:${String(pull.merge_commit_sha ?? "")}`,
        },
      ];
    }

    default:
      return [];
  }
}
