import { NextRequest } from "next/server";
import { asSignedIn } from "@/lib/auth/user";
import { z } from "zod";
import { createTodoItem } from "@/lib/board/service";
import { activeProject, noProject } from "@/lib/board/project";
import { limited, RUN } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
// POST starts the Architect Agent drafting the ticket (see launch() in
// src/lib/agents/pipeline.ts). Matches the platform's function cap;
// DEFAULT_RUN_BUDGET stays under it.
export const maxDuration = 300;

const bodySchema = z.object({
  rawRequest: z.string().trim().min(3, "Describe the ticket in a sentence or two.").max(4000),
  requestId: z.string().optional(),
});

export const POST = asSignedIn(postHandler);
async function postHandler(req: NextRequest) {
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
  const card = await createTodoItem(project.id, parsed.data.rawRequest, {
    requestId: parsed.data.requestId,
  });
  return Response.json({ card }, { status: 201 });
}
