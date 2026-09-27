import type { Instrumentation } from "next";

/**
 * Startup hook. Runs once per server process, before the first request.
 *
 * The only thing here is orphan recovery: a run that was live when the last
 * process died is, by definition, not live now. See
 * src/lib/agents/recovery.ts.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { reconcileOrphanedRuns } = await import("@/lib/agents/recovery");
  try {
    const reclaimed = await reconcileOrphanedRuns();
    if (reclaimed > 0) {
      console.info(`[formic] failed ${reclaimed} run(s) orphaned by a restart`);
    }
  } catch (e) {
    // A database that is not up yet must not stop the server from booting.
    console.warn("[formic] orphan recovery skipped:", e);
  }

  await seedIfEmpty();
}

/**
 * Every server error Next.js catches — a thrown route handler, a failed
 * render, a server action — comes through here. See AUD-10: the operator
 * should see this before a beta user reports it, with the route and the
 * commit that produced it, and nothing secret.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, _request, context) => {
  const { trackThrown } = await import("@/lib/observability/error-tracking");
  const digest =
    typeof error === "object" && error !== null && "digest" in error
      ? String((error as { digest: unknown }).digest)
      : undefined;
  trackThrown(error, { route: context.routePath, digest, source: "server" });
};

/**
 * A configured database starts with no tables' worth of data behind it, and
 * nothing ever runs `prisma db push`'s data-loading sibling against it
 * automatically. Rather than ship that as a manual step, seed the demo board
 * once, the first time a real database comes up with zero epics in it. Never
 * touches a database that already has content, so real work created later is
 * never at risk from this running again on the next restart.
 */
async function seedIfEmpty(): Promise<void> {
  const { hasDatabase, prisma } = await import("@/lib/db/client");
  if (!hasDatabase()) return;

  try {
    const client = prisma();
    const epicCount = await client.epic.count();
    if (epicCount > 0) return;

    const { seedDemoBoard } = await import("@/lib/db/seed");
    await seedDemoBoard(client);
    console.info("[formic] seeded the demo board into an empty database");
  } catch (e) {
    console.warn("[formic] demo seed skipped:", e);
  }
}
