import { NextRequest } from "next/server";
import { repository } from "@/lib/db";
import { applyTransition } from "@/lib/board/service";
import { cardTransitionSchema } from "@/lib/domain/transitions";

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

  const project = await repository().defaultProject();
  const result = await applyTransition(project.id, parsed.data);
  return Response.json(result, { status: result.ok ? 200 : 409 });
}
