import { repository } from "@/lib/db";
import { activeProject } from "@/lib/board/project";

export const dynamic = "force-dynamic";

/** Where the next page starts in each list: null once that list is spent. */
type Cursor = { t: string | null; e: string | null };

const encode = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString("base64url");

function decode(raw: string): Cursor | null {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString()) as Partial<Cursor>;
    const ok = (v: unknown) => v === null || typeof v === "string";
    return ok(c.t) && ok(c.e) && c.t !== undefined && c.e !== undefined ? (c as Cursor) : null;
  } catch {
    return null;
  }
}

/**
 * The archive: a page of the tickets and Epics archived off this project's
 * board. One opaque cursor pages both lists; nextCursor is null on the last page.
 */
export async function GET(req: Request) {
  const repo = repository();
  const project = await activeProject();
  if (!project) return Response.json({ tickets: [], epics: [], nextCursor: null });
  const raw = new URL(req.url).searchParams.get("cursor");
  const cursor = raw ? decode(raw) : { t: undefined, e: undefined };
  if (!cursor) return Response.json({ error: "Not a page of the archive." }, { status: 400 });
  const empty = { cards: [], nextCursor: null };
  const [tickets, epics] = await Promise.all([
    cursor.t === null ? empty : repo.archivedTickets(project.id, { cursor: cursor.t }),
    cursor.e === null ? empty : repo.archivedEpics(project.id, { cursor: cursor.e }),
  ]);
  const nextCursor =
    tickets.nextCursor || epics.nextCursor ? encode({ t: tickets.nextCursor, e: epics.nextCursor }) : null;
  return Response.json({ tickets: tickets.cards, epics: epics.cards, nextCursor });
}
