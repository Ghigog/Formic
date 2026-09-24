import { NextRequest } from "next/server";
import { z } from "zod";
import { createTodoItem } from "@/lib/board/service";
import { activeProject, noProject } from "@/lib/board/project";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  rawRequest: z.string().min(3, "Describe the ticket in a sentence or two.").max(4000),
  requestId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 },
    );
  }

  const project = await activeProject();
  if (!project) return noProject();
  const card = await createTodoItem(project.id, parsed.data.rawRequest, parsed.data.requestId);
  return Response.json({ card }, { status: 201 });
}
