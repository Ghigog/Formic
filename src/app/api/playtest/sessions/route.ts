import { asSignedIn } from "@/lib/auth/user";
import { repository } from "@/lib/db";
import { playtestBoard } from "@/lib/playtest/route-helpers";
import { viewOf } from "@/lib/playtest/service";

export const dynamic = "force-dynamic";

/** The board's playtests, newest first, with whose each was. */
export const GET = asSignedIn(async () => {
  const found = await playtestBoard();
  if ("error" in found) return found.error;
  const repo = repository();
  const sessions = await repo.playtestsFor(found.project.id, 30);
  const names = new Map<string, string>();
  for (const s of sessions) {
    if (names.has(s.userId)) continue;
    const u = await repo.userById(s.userId).catch(() => null);
    names.set(s.userId, u?.name || u?.login || "Someone");
  }
  const notes = await Promise.all(
    sessions.map(async (s) => (await repo.playtestMessages(s.id)).filter((m) => m.role === "user").length),
  );
  return Response.json({
    sessions: sessions.map((s, i) => ({ ...viewOf(s), by: names.get(s.userId), mine: s.userId === found.user.id, notes: notes[i] })),
  });
});
