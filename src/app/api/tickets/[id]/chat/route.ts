import { NextRequest } from "next/server";
import { z } from "zod";

import { ChatBusyError, ask } from "@/lib/agents/card-chat";
import { activeProject } from "@/lib/board/project";
import { MAX_NOTE } from "@/lib/coder/notes";
import { repository } from "@/lib/db";

export const dynamic = "force-dynamic";

const askSchema = z.object({ text: z.string().trim().min(1).max(MAX_NOTE) });

/** The active project, if this ticket is on it. Anyone else's ticket is a 404. */
async function projectOwning(ticketId: string) {
  const project = await activeProject();
  if (!project) return null;
  return (await repository().projectOfCard(ticketId)) === project.id ? project : null;
}

const notFound = () => Response.json({ error: "Not found" }, { status: 404 });

async function state(ticketId: string) {
  return { messages: await repository().cardChatMessages(ticketId) };
}

/** A ticket's chat with the Architect Agent, or whichever agent its column runs now. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const project = await projectOwning(id);
  if (!project) return notFound();
  return Response.json(await state(id));
}

/** Asks the ticket's column agent something. The answer arrives on a later GET. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const project = await projectOwning(id);
  if (!project) return notFound();
  const body = askSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Ask something first." }, { status: 400 });

  try {
    await ask(project.id, "ticket", id, body.data.text);
  } catch (e) {
    if (e instanceof ChatBusyError) return Response.json({ error: e.message }, { status: 409 });
    throw e;
  }
  return Response.json(await state(id));
}

/** Starts the ticket's chat over. */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const project = await projectOwning(id);
  if (!project) return notFound();
  await repository().clearCardChat(id);
  return Response.json(await state(id));
}
