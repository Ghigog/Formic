import { NextRequest } from "next/server";
import { applyTransition } from "@/lib/board/service";
import { cardTransitionSchema } from "@/lib/domain/transitions";
import { activeProject } from "@/lib/board/project";

export const dynamic = "force-dynamic";

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
  const result = await applyTransition(project.id, parsed.data);
  return Response.json(result, { status: result.ok ? 200 : 409 });
}
