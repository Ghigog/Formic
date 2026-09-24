import { NextRequest } from "next/server";
import { z } from "zod";

import { receiveReport, reportAllowed } from "@/lib/runner/runner";

export const dynamic = "force-dynamic";

const body = z.object({
  lines: z.array(z.string()).max(2_000).default([]),
  after: z.number().int().min(0).default(0),
});

/**
 * A CLI agent's output, posted by the workflow as it works. Open to the
 * internet, like the webhook, and just as careful: the token in the address
 * is good for its one job, and only while that job's card waits on it.
 */
export async function POST(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const job = q.get("job") ?? "";
  const since = q.get("since") ?? "";
  if (!job || !reportAllowed(job, since, q.get("token") ?? "")) {
    return Response.json({ error: "Not allowed" }, { status: 403 });
  }
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Bad report" }, { status: 400 });

  const reply = await receiveReport({ job, since: Number(since), ...parsed.data });
  return Response.json(reply);
}
