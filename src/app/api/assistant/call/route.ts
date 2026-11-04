import { launch } from "@/lib/agents/pipeline";
import { answer } from "@/lib/assistant/turn";
import { asSignedIn, currentUser } from "@/lib/auth/user";
import { activeProject, noProject } from "@/lib/board/project";
import { repository } from "@/lib/db";
import { openerPrompt } from "@/lib/pm/questions";
import { limited, RUN } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * A PM call started: the PM opens it, through the same queue as a typed
 * message, with the questions waiting on the person or a greeting.
 */
export const POST = asSignedIn(async (req: Request) => {
  const refused = limited(req, RUN, "run-start");
  if (refused) return refused;
  if (!(await currentUser())) return Response.json({ error: "Sign in first." }, { status: 401 });
  const project = await activeProject();
  if (!project) return noProject();

  const repo = repository();
  const projectId = project.id;
  // The queue starts a later reply without a prompt, so an opener only goes
  // in when the PM is free; a call that starts mid-answer simply listens.
  if ((await repo.assistantMessages(projectId)).some((m) => m.status === "pending")) return Response.json({ id: null });
  const waiting = (await repo.boardCards(projectId)).filter((c) => c.blockedReason);
  const pending = await repo.addAssistantMessage({ projectId, role: "assistant", content: "", status: "pending" });
  launch(() => answer(projectId, pending.id, openerPrompt(waiting)), `assistant opener ${pending.id}`);
  return Response.json({ id: pending.id });
});
