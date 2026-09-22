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
}
