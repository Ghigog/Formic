import { NextRequest } from "next/server";
import { asSignedIn } from "@/lib/auth/user";
import { applyTransition } from "@/lib/board/service";
import { cardTransitionSchema } from "@/lib/domain/transitions";
import { activeProject, noProject } from "@/lib/board/project";
import { repository } from "@/lib/db";
import { columnOf } from "@/lib/domain/status";
import { limited, RUN } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
// A transition can start the Architect, Product, Coder or Reviewer Agent
// (see launch() in src/lib/agents/pipeline.ts). Matches the platform's
// function cap; DEFAULT_RUN_BUDGET stays under it.
export const maxDuration = 300;

export const POST = asSignedIn(postHandler);
async function postHandler(req: NextRequest) {
  const refused = limited(req, RUN, "run-start");
  if (refused) return refused;

  const body = await req.json().catch(() => null);
  const parsed = cardTransitionSchema.safeParse(body);

  if (!parsed.success) {
    const cardId = (body as { cardId?: unknown } | null)?.cardId;
    const card = typeof cardId === "string" && cardId ? await repository().cardById(cardId) : null;
    return Response.json(
      {
        ok: false,
        reason: "Malformed transition request.",
        ...(card && { revertTo: columnOf(card) }),
      },
      { status: 400 },
    );
  }

  const project = await activeProject();
  if (!project) return noProject();
  const result = await applyTransition(project.id, parsed.data);
  return Response.json(result, { status: result.ok ? 200 : 409 });
}
