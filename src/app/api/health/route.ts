import {
  SESSION_COOKIE,
  authMode,
  gatePassword,
  passwordToken,
  safeEqual,
  secretProblem,
  verifySession,
} from "@/lib/auth/session";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { hasDatabase } from "@/lib/db";
import { prisma } from "@/lib/db/client";
import { usingMockAgents } from "@/lib/agents/registry";
import { activeRunCount } from "@/lib/budget/controller";
import { activeSandboxCount, LOCAL_SANDBOX_ON_VERCEL } from "@/lib/sandbox";
import { mergeTarget, usingMockVcs } from "@/lib/vcs";
import { configWarnings, env } from "@/lib/secrets/env";
import { redact } from "@/lib/secrets/redact";
import { reportAllowed } from "@/lib/runner/runner";

export const dynamic = "force-dynamic";

/** The full report, for someone signed in (or a runner carrying its token). */
type FullReport = {
  ok: boolean;
  commit: string | null;
  buildId: string;
  database: "memory" | "postgres" | "unreachable";
  databaseError?: string;
  agents: string;
  sandbox: string;
  github: string;
  webhook: string;
  access: string;
  mergeTarget: string;
  activeRuns: number;
  activeSandboxes: number;
  warnings: string[];
};

/**
 * What this process actually is, and whether it can do its job.
 *
 * `commit` confirms a deploy is serving the build you think it is (a stale
 * server answers every request perfectly well). The database is pinged, not
 * just checked for a URL: a configured-but-unreachable database is exactly
 * the failure a URL check reports as healthy. Config problems are listed as
 * warnings; they degrade a feature, they don't take the app down.
 *
 * The endpoint is public, so a stranger gets only whether the app is up
 * (`ok`, `commit`, `database`); the rest of the report describes the
 * deployment's configuration and is for the operator. A signed-in session —
 * or a runner presenting the token its job was issued — gets the full
 * report, which is what the smoke test and the runbook read.
 */
export async function GET(req: Request) {
  const full = await fullReport();
  const body = (await trusted(req)) ? full : publicSlice(full);
  return Response.json(body, { status: full.ok ? 200 : 503 });
}

/**
 * `ok`, `commit` and `database`: enough for a monitor to know the deploy is
 * live and serving this commit, and nothing a stranger could use to learn
 * how the deployment is configured.
 */
function publicSlice(full: FullReport) {
  return { ok: full.ok, commit: full.commit, database: full.database };
}

/**
 * Whether the caller is the operator rather than the public: a valid session
 * cookie (GitHub or the local password gate), or a runner's one-job token.
 */
async function trusted(req: Request): Promise<boolean> {
  const url = new URL(req.url);
  if (
    reportAllowed(
      url.searchParams.get("job") ?? "",
      url.searchParams.get("since") ?? "",
      url.searchParams.get("token") ?? "",
    )
  ) {
    return true;
  }

  const cookie = cookieValue(req, SESSION_COOKIE);
  if (authMode() === "github") return (await verifySession(cookie)) !== null;
  const password = gatePassword();
  if (!password) return false;
  return !!cookie && safeEqual(cookie, await passwordToken(password));
}

/** One cookie out of a Cookie header, or undefined when it isn't there. */
function cookieValue(req: Request, name: string): string | undefined {
  const jar = req.headers.get("cookie");
  if (!jar) return undefined;
  for (const part of jar.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

async function fullReport(): Promise<FullReport> {
  let buildId = "unknown";
  try {
    buildId = (
      await readFile(path.join(process.cwd(), ".next", "BUILD_ID"), "utf8")
    ).trim();
  } catch {
    // Not fatal: dev mode has no BUILD_ID.
  }

  const config = env();
  const warnings = [...configWarnings()];
  if (process.env.VERCEL && config.SANDBOX_PROVIDER === "local") {
    warnings.push(LOCAL_SANDBOX_ON_VERCEL);
  }
  const secretIssue = secretProblem();
  if (secretIssue) warnings.push(secretIssue);

  let database: "memory" | "postgres" | "unreachable" = "memory";
  let databaseError: string | undefined;
  if (hasDatabase()) {
    try {
      await withTimeout(prisma().$queryRaw`SELECT 1`, 5_000);
      database = "postgres";
    } catch (e) {
      database = "unreachable";
      databaseError = redact(e instanceof Error ? e.message : String(e));
    }
  }

  const ok = database !== "unreachable" && !secretIssue;
  return {
    ok,
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    buildId,
    database,
    ...(databaseError ? { databaseError } : {}),
    // Signed in with GitHub, agents run on each person's own Anthropic key,
    // so the server having none does not make them mocks.
    agents: authMode() === "github" ? "per-user" : usingMockAgents() ? "mock" : "anthropic",
    sandbox: config.SANDBOX_PROVIDER,
    // Signed in with GitHub, each board uses its owner's token.
    github: authMode() === "github" ? "per-user" : usingMockVcs() ? "mock" : "live",
    webhook: config.GITHUB_WEBHOOK_SECRET ? "configured" : "unconfigured",
    access: authMode() === "github" ? "github" : gatePassword() ? "password" : "open",
    mergeTarget: mergeTarget(config.GITHUB_BASE_BRANCH),
    activeRuns: activeRunCount(),
    activeSandboxes: activeSandboxCount(),
    warnings,
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
