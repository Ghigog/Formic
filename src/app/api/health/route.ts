import { readFile } from "node:fs/promises";
import path from "node:path";
import { hasDatabase } from "@/lib/db";
import { useMockAgents } from "@/lib/agents/registry";
import { activeRunCount } from "@/lib/budget/controller";

export const dynamic = "force-dynamic";

/**
 * What this process actually is. Used to confirm a deploy is serving the build
 * you think it is, which is otherwise invisible: a stale server answers every
 * request perfectly well.
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

  return Response.json({
    ok: true,
    buildId,
    database: hasDatabase() ? "postgres" : "memory",
    agents: useMockAgents() ? "mock" : "anthropic",
    sandbox: process.env.SANDBOX_PROVIDER ?? "local",
    activeRuns: activeRunCount(),
  });
}
