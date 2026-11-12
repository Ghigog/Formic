import { z } from "zod";

import { launch } from "@/lib/agents/pipeline";
import { answer, cancelPending } from "@/lib/assistant/turn";
import { collectCliRuns } from "@/lib/runner/runner";
import { asSignedIn, currentUser } from "@/lib/auth/user";
import { activeProject, noProject } from "@/lib/board/project";
import { repository } from "@/lib/db";
import type { ProjectSummary, UserRecord } from "@/lib/db/repository";
import { isGuestId } from "@/lib/assistant/guest-ids";
import { assistantPick } from "@/lib/agents/board-agents";
import { limited, RUN } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const askSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
  /** Who answers, in order: the PM by default. */
  speakers: z.array(z.string().refine((v) => v !== "pm" && isGuestId(v), "Not someone who can answer here.")).min(1).max(8).default(["assistant"]),
});

async function board() {
  const user = await currentUser();
  if (!user) return { error: Response.json({ error: "Sign in first." }, { status: 401 }) };
  const project = await activeProject();
  if (!project) return { error: noProject() };
  return { project, user };
}

async function state(project: ProjectSummary, user: UserRecord, before?: string) {
  const projectId = project.id;
  const repo = repository();
  // An answer from GitHub Actions is collected here too, not only when the
  // webhook arrives. Never fails the read.
  await collectCliRuns(projectId).catch((e: unknown) =>
    console.warn("[formic] could not check the agents' runs:", e),
  );
  return {
    presetId: await assistantPick(project, user),
    // When this person last read the chat, so a newer message can be marked New.
    readAt: (await repo.pmReadAt(user.id, projectId))?.toISOString() ?? null,
    ...(await repo.assistantMessages(projectId, { before })),
  };
}

/** The assistant's conversation on the active board, and its agent. */
export async function GET(req: Request) {
  const found = await board();
  if ("error" in found) return found.error;
  const before = new URL(req.url).searchParams.get("before") ?? undefined;
  return Response.json(await state(found.project, found.user, before));
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
  // Messages queue: a reply starts only when no earlier one is pending, and
  // each finished one starts the next.
  const busy = !!(await repo.pendingAssistantMessage(projectId));
  await repo.addAssistantMessage({ projectId, role: "user", content: body.data.text });
  const replies = [];
  for (const speaker of body.data.speakers) {
    replies.push(await repo.addAssistantMessage({ projectId, role: "assistant", content: "", status: "pending", speaker }));
  }
  const first = replies[0];
  if (!busy && first) launch(() => answer(projectId, first.id), `assistant answer ${first.id}`);
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
