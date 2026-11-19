import { z } from "zod";

import { asSignedIn } from "@/lib/auth/user";
import { messageView, playtestOnBoard } from "@/lib/playtest/route-helpers";
import { addNote } from "@/lib/playtest/service";

export const dynamic = "force-dynamic";

const noteSchema = z
  .object({
    text: z.string().max(20_000).default(""),
    /** The request ids the note's screenshots were uploaded under. */
    shots: z.array(z.string().startsWith("playtest-").max(200)).max(5).default([]),
  })
  .refine((n) => n.text.trim() || n.shots.length, "Write something or add a screenshot.");

/** A note in the person's playtest. The PM is asked separately, once they pause (../ask). */
export const POST = asSignedIn(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const found = await playtestOnBoard((await params).id, true);
  if ("error" in found) return found.error;
  const body = noteSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Write something or add a screenshot." }, { status: 400 });
  const note = await addNote(found.record, body.data.text, body.data.shots);
  return Response.json({ message: messageView(note) }, { status: 201 });
});
