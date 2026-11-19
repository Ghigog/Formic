import { asSignedIn } from "@/lib/auth/user";
import { repository } from "@/lib/db";
import { messageView, playtestOnBoard } from "@/lib/playtest/route-helpers";
import { stopPlaytest, tick, viewOf } from "@/lib/playtest/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * A playtest's state and its messages. The person's own open session is also
 * kept alive by this poll (see tick); anyone on the board can read a past one.
 */
export const GET = asSignedIn(async (_req: Request, { params }: Params) => {
  const found = await playtestOnBoard((await params).id, false);
  if ("error" in found) return found.error;
  const record = found.record.userId === found.user.id ? await tick(found.record, found.project) : found.record;
  const messages = await repository().playtestMessages(record.id);
  return Response.json({ session: viewOf(record), messages: messages.map(messageView), own: record.userId === found.user.id });
});

/** Stops the person's playtest and its sandbox. */
export const DELETE = asSignedIn(async (_req: Request, { params }: Params) => {
  const found = await playtestOnBoard((await params).id, true);
  if ("error" in found) return found.error;
  const record = await stopPlaytest(found.record.id, "stopped");
  return Response.json({ session: record ? viewOf(record) : null });
});
