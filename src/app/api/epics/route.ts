import { NextRequest } from "next/server";
import { z } from "zod";
import { createBacklogItem } from "@/lib/board/service";
import { activeProject } from "@/lib/board/project";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  rawRequest: z.string().min(3, "Describe the feature in a sentence or two.").max(4000),
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
  const card = await createBacklogItem(project.id, parsed.data.rawRequest);
  return Response.json({ card }, { status: 201 });
}
