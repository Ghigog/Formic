import { NextRequest } from "next/server";
import { z } from "zod";

import { repository } from "@/lib/db";
import { activeProject } from "@/lib/board/project";
import { answerFollowUp } from "@/lib/board/follow-ups";
import { limited, RUN } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const body = z.object({
  /** Which of the ticket's follow-ups, by its place in the list. */
  index: z.number().int().min(0),
  /** True adds it as a tech debt ticket on the same Epic; false dismisses it. */
  add: z.boolean(),
});

/** The person's answer to a follow-up an agent proposed on this ticket. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const refused = limited(req, RUN, "ticket-follow-up");
  if (refused) return refused;
  const { id } = await params;
  const project = await activeProject();
  if (!project || (await repository().projectOfCard(id)) !== project.id) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Say which follow-up, and whether to add it." }, { status: 400 });
  const answer = await answerFollowUp(project.id, id, parsed.data.index, parsed.data.add);
  return answer.ok
    ? Response.json({ message: answer.message })
    : Response.json({ error: answer.error }, { status: 409 });
}
