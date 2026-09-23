import { z } from "zod";

import { applyAction, checkAction } from "@/lib/assistant/actions";
import { currentUser } from "@/lib/auth/user";
import { activeProject, noProject } from "@/lib/board/project";
import { repository } from "@/lib/db";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  messageId: z.string().min(1),
  index: z.number().int().min(0),
  decision: z.enum(["apply", "dismiss"]),
});

/**
 * The person's answer to one of the assistant's proposals. Applying is the
 * only way anything the assistant suggests reaches the board.
 */
export async function POST(req: Request) {
  const body = bodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Malformed decision." }, { status: 400 });

  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const project = await activeProject();
  if (!project) return noProject();

  const repo = repository();
  const message = await repo.assistantMessage(body.data.messageId);
  const proposal = message?.proposals[body.data.index];
  if (!message || message.projectId !== project.id || !proposal) {
    return Response.json({ error: "That proposal no longer exists." }, { status: 404 });
  }
  if (proposal.state !== "proposed") {
    return Response.json({ error: "That proposal was already decided." }, { status: 409 });
  }

  const proposals = [...message.proposals];
  if (body.data.decision === "dismiss") {
    proposals[body.data.index] = { ...proposal, state: "dismissed" };
  } else {
    // Mark it first, so a double click cannot apply it twice.
    proposals[body.data.index] = { ...proposal, state: "applied" };
    await repo.updateAssistantMessage(message.id, { proposals });
    const checked = checkAction(proposal.action);
    try {
      if (!checked.ok) throw new Error(checked.problem);
      const done = await applyAction(project.id, checked.action);
      await repo.addAssistantMessage({ projectId: project.id, role: "assistant", content: done });
    } catch (e) {
      proposals[body.data.index] = {
        ...proposal,
        state: "failed",
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
  await repo.updateAssistantMessage(message.id, { proposals });

  return Response.json({
    presetId: await repo.assistantAgent(project.id),
    messages: await repo.assistantMessages(project.id),
  });
}
