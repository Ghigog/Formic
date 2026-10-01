import { z } from "zod";
import { repository } from "@/lib/db";
import { activeProject, noProject } from "@/lib/board/project";
import { currentUser } from "@/lib/auth/user";
import { COLUMNS } from "@/lib/domain/status";

export const dynamic = "force-dynamic";

const count = z.number().int().min(1).nullable();

/** Strict: money is not a setting, so a cents field is refused. */
const bodySchema = z
  .object({ minutes: count.default(null), tokens: count.default(null), attempts: count.default(null) })
  .strict();

/** This column agent's own limits on the active board; null on an axis falls back to the person's setting. */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ column: string }> },
) {
  const { column } = await params;
  const col = z.enum(COLUMNS).safeParse(column);
  const body = bodySchema.safeParse(await req.json().catch(() => null));
  if (!col.success || !body.success) {
    return Response.json(
      { error: body.success ? "Expected a column." : (body.error.issues[0]?.message ?? "Malformed.") },
      { status: 400 },
    );
  }

  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const project = await activeProject();
  if (!project) return noProject();
  const repo = repository();
  if (!(await repo.setColumnOverride(project.id, col.data, body.data))) {
    return Response.json({ error: "Pick an agent for that column first." }, { status: 404 });
  }
  return Response.json({ overrides: await repo.columnOverrides(project.id) });
}
