import { NextRequest } from "next/server";
import { applyTransition } from "@/lib/board/service";
import { cardTransitionSchema } from "@/lib/domain/transitions";
import { activeProject, noProject } from "@/lib/board/project";

export const dynamic = "force-dynamic";
// A transition can start the Architect, Product, Coder or Reviewer Agent
// (see launch() in src/lib/agents/pipeline.ts). Matches the platform's
// function cap; DEFAULT_RUN_BUDGET stays under it.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = cardTransitionSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      {
        ok: false,
        reason: "Malformed transition request.",
        revertTo: "backlog",
      },
      { status: 400 },
    );
  }

  const project = await activeProject();
  if (!project) return noProject();
  const result = await applyTransition(project.id, parsed.data);
  return Response.json(result, { status: result.ok ? 200 : 409 });
}
