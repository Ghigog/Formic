import { asSignedIn } from "@/lib/auth/user";
import { playtestOnBoard } from "@/lib/playtest/route-helpers";
import { askAboutNotes } from "@/lib/playtest/service";

export const dynamic = "force-dynamic";

/** The person paused: the PM answers every note since it was last asked, together. */
export const POST = asSignedIn(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const found = await playtestOnBoard((await params).id, true);
  if ("error" in found) return found.error;
  return Response.json({ asked: await askAboutNotes(found.record) });
});
