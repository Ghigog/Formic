import { authMode, gatePassword } from "@/lib/auth/session";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { hasDatabase } from "@/lib/db";
import { prisma } from "@/lib/db/client";
import { useMockAgents } from "@/lib/agents/registry";
import { activeRunCount } from "@/lib/budget/controller";
import { activeSandboxCount, LOCAL_SANDBOX_ON_VERCEL } from "@/lib/sandbox";
import { mergeTarget, usingMockVcs } from "@/lib/vcs";
import { configWarnings, env } from "@/lib/secrets/env";
import { redact } from "@/lib/secrets/redact";

export const dynamic = "force-dynamic";

/**
 * What this process actually is, and whether it can do its job.
 *
 * `commit` confirms a deploy is serving the build you think it is (a stale
 * server answers every request perfectly well). The database is pinged, not
 * just checked for a URL: a configured-but-unreachable database is exactly
 * the failure a URL check reports as healthy. Config problems are listed as
 * warnings; they degrade a feature, they don't take the app down.
 */
export async function GET() {
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

  const ok = database !== "unreachable";
  return Response.json(
    {
      ok,
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      buildId,
      database,
      ...(databaseError ? { databaseError } : {}),
      agents: useMockAgents() ? "mock" : "anthropic",
      sandbox: config.SANDBOX_PROVIDER,
      // Signed in with GitHub, each board uses its owner's token.
      github: authMode() === "github" ? "per-user" : usingMockVcs() ? "mock" : "live",
      webhook: config.GITHUB_WEBHOOK_SECRET ? "configured" : "unconfigured",
      access: authMode() === "github" ? "github" : gatePassword() ? "password" : "open",
      mergeTarget: mergeTarget(config.GITHUB_BASE_BRANCH),
      activeRuns: activeRunCount(),
      activeSandboxes: activeSandboxCount(),
      warnings,
    },
    { status: ok ? 200 : 503 },
  );
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
