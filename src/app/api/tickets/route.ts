import { NextRequest } from "next/server";
import { z } from "zod";
import { WORK_TYPES } from "@/lib/domain/entities";
import { createTodoItem } from "@/lib/board/service";
import { activeProject, noProject } from "@/lib/board/project";
import { limited, RUN } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
// POST starts the Architect Agent drafting the ticket (see launch() in
// src/lib/agents/pipeline.ts). Matches the platform's function cap;
// DEFAULT_RUN_BUDGET stays under it.
export const maxDuration = 300;

const bodySchema = z.object({
  rawRequest: z.string().min(3, "Describe the ticket in a sentence or two.").max(4000),
  requestId: z.string().optional(),
  workType: z.enum(WORK_TYPES).optional(),
});

export async function POST(req: NextRequest) {
  const refused = limited(req, RUN, "run-start");
  if (refused) return refused;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 },
    );
  }

  const project = await activeProject();
  if (!project) return noProject();
  const card = await createTodoItem(project.id, parsed.data.rawRequest, parsed.data.requestId, parsed.data.workType);
  return Response.json({ card }, { status: 201 });
}
