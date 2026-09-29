import { NextRequest } from "next/server";

import { loopBundle } from "@/lib/runner/bundle";
import { reportAllowed } from "@/lib/runner/runner";

export const dynamic = "force-dynamic";

/**
 * The loop entry, as one file: what a GitHub Actions job runs so an agent on
 * an API key can work where a CLI agent works, for as long as its budget
 * allows instead of the serverless window. Built at deploy time from the
 * commit being deployed (scripts/build-loop-entry.mjs), and served only to
 * the job it belongs to: the same signed address as the report endpoint, so
 * the token is good for one pending job and no longer.
 *
 * The commit it was built from travels in a header, and inside the file, so a
 * run can always be traced back to code someone can identify.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const job = q.get("job") ?? "";
  const since = q.get("since") ?? "";
  if (!job || !reportAllowed(job, since, q.get("token") ?? "")) {
    return Response.json({ error: "Not allowed" }, { status: 403 });
  }

  const bundle = await loopBundle();
  if (!bundle) {
    return Response.json(
      { error: "This deployment has no loop bundle: it was built without one." },
      { status: 503 },
    );
  }

  return new Response(bundle.code, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      // One job's copy: a cached one from another job is not this one.
      "cache-control": "no-store",
      "x-formic-commit": bundle.commit,
      "x-formic-built": bundle.builtAt,
    },
  });
}
