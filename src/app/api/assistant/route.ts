import { z } from "zod";

import { launch } from "@/lib/agents/pipeline";
import { answer, cancelPending } from "@/lib/assistant/turn";
import { collectCliRuns } from "@/lib/runner/runner";
import { asSignedIn, currentUser } from "@/lib/auth/user";
import { activeProject, noProject } from "@/lib/board/project";
import { repository } from "@/lib/db";
import type { ProjectSummary, UserRecord } from "@/lib/db/repository";
import { assistantPick } from "@/lib/agents/board-agents";
import { limited, RUN } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const askSchema = z.object({ text: z.string().trim().min(1).max(20_000) });

async function board() {
  const user = await currentUser();
  if (!user) return { error: Response.json({ error: "Sign in first." }, { status: 401 }) };
  const project = await activeProject();
  if (!project) return { error: noProject() };
  return { project, user };
}

async function state(project: ProjectSummary, user: UserRecord) {
  const projectId = project.id;
  const repo = repository();
  // An answer from GitHub Actions is collected here too, not only when the
  // webhook arrives. Never fails the read.
  await collectCliRuns(projectId).catch((e: unknown) =>
    console.warn("[formic] could not check the agents' runs:", e),
  );
  return {
    presetId: await assistantPick(project, user),
    messages: await repo.assistantMessages(projectId),
  };
}

/** The assistant's conversation on the active board, and its agent. */
export async function GET() {
  const found = await board();
  if ("error" in found) return found.error;
  return Response.json(await state(found.project, found.user));
}

/** Asks the assistant something. The answer arrives on a later GET. */
export const POST = asSignedIn(postHandler);
async function postHandler(req: Request) {
  const refused = limited(req, RUN, "run-start");
  if (refused) return refused;

  const found = await board();
  if ("error" in found) return found.error;
  const body = askSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Ask something first." }, { status: 400 });

  const repo = repository();
  const projectId = found.project.id;
  const pending = (await repo.assistantMessages(projectId)).some((m) => m.status === "pending");
  if (pending) {
    return Response.json({ error: "The assistant is still answering the last question." }, { status: 409 });
  }

  await repo.addAssistantMessage({ projectId, role: "user", content: body.data.text });
  const reply = await repo.addAssistantMessage({
    projectId,
    role: "assistant",
    content: "",
    status: "pending",
  });
  launch(() => answer(projectId, reply.id), `assistant answer ${reply.id}`);
  return Response.json(await state(found.project, found.user));
}

/** Stops waiting for the pending answer; a new question is accepted after. */
export async function PATCH() {
  const found = await board();
  if ("error" in found) return found.error;
  await cancelPending(found.project.id);
  return Response.json(await state(found.project, found.user));
}

/** Starts the conversation over. */
export async function DELETE() {
  const found = await board();
  if ("error" in found) return found.error;
  await repository().clearAssistant(found.project.id);
  return Response.json(await state(found.project, found.user));
}
