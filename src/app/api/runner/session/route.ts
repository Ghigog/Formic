import { NextRequest } from "next/server";
import { z } from "zod";

import { collectHandoff, receiveSessionFile, sessionAllowed } from "@/lib/assistant/session";

export const dynamic = "force-dynamic";

/** A session file, gzipped and base64: comfortably over the cap, which the store enforces. */
const MAX_FILE_CHARS = 16 * 1024 * 1024;

const upload = z.object({
  sessionId: z.string().max(200).default(""),
  branch: z.string().max(300).default(""),
  file: z.string().max(MAX_FILE_CHARS).default(""),
});

function allowed(req: NextRequest): string | null {
  const q = req.nextUrl.searchParams;
  const job = q.get("job") ?? "";
  return sessionAllowed(job, q.get("expires") ?? "", q.get("token") ?? "") ? job : null;
}

/**
 * The board's PM session, for the job running its turn: collected once when
 * the job starts (the session file and a board-scoped MCP token), and handed
 * back when it ends. Open to the internet, like the run report, and as
 * careful: the address is signed for its one job, expires, and only works
 * while that job is the session's current turn. See src/lib/assistant/session.
 */
export async function GET(req: NextRequest) {
  const job = allowed(req);
  if (!job) return Response.json({ error: "Not allowed" }, { status: 403 });
  const handoff = await collectHandoff(job);
  if (!handoff) return Response.json({ error: "Already collected, or no turn is waiting on this job." }, { status: 410 });
  return Response.json(handoff, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const job = allowed(req);
  if (!job) return Response.json({ error: "Not allowed" }, { status: 403 });
  const parsed = upload.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Bad session" }, { status: 400 });
  if (!(await receiveSessionFile(job, parsed.data))) {
    return Response.json({ error: "No turn is waiting on this job." }, { status: 410 });
  }
  return Response.json({ ok: true });
}
