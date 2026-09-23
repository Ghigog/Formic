import { z } from "zod";

import { launch } from "@/lib/agents/pipeline";
import { answer } from "@/lib/assistant/turn";
import { collectCliAsk } from "@/lib/runner/runner";
import { currentUser } from "@/lib/auth/user";
import { activeProject, noProject } from "@/lib/board/project";
import { repository } from "@/lib/db";

export const dynamic = "force-dynamic";

const askSchema = z.object({ text: z.string().trim().min(1).max(20_000) });

async function board() {
  const user = await currentUser();
  if (!user) return { error: Response.json({ error: "Sign in first." }, { status: 401 }) };
  const project = await activeProject();
  if (!project) return { error: noProject() };
  return { project };
}

async function state(projectId: string) {
  const repo = repository();
  // An answer from GitHub Actions is collected here too, not only when the
  // webhook arrives. Never fails the read.
  for (const m of await repo.assistantMessages(projectId)) {
    if (m.status === "pending" && m.runnerJob) {
      await collectCliAsk(projectId, m.id).catch((e) =>
        console.warn("[formic] could not check the assistant's run:", e),
      );
    }
  }
  return {
    presetId: await repo.assistantAgent(projectId),
    messages: await repo.assistantMessages(projectId),
  };
}

/** The assistant's conversation on the active board, and its agent. */
export async function GET() {
  const found = await board();
  if ("error" in found) return found.error;
  return Response.json(await state(found.project.id));
}

/** Asks the assistant something. The answer arrives on a later GET. */
export async function POST(req: Request) {
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
  return Response.json(await state(projectId));
}

/** Starts the conversation over. */
export async function DELETE() {
  const found = await board();
  if ("error" in found) return found.error;
  await repository().clearAssistant(found.project.id);
  return Response.json(await state(found.project.id));
}
