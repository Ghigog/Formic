import { z } from "zod";
import { repository } from "@/lib/db";
import { canSee, currentUser } from "@/lib/auth/user";
import type { UserRecord } from "@/lib/db/repository";
import { hintFor, seal } from "@/lib/secrets/vault";

export const dynamic = "force-dynamic";

/** A new key; null removes the saved one; omitted leaves it. */
const keySchema = z.string().trim().min(1).max(500).nullable().optional();
const bodySchema = z.object({
  e2bKey: keySchema,
  projectId: z.string().min(1).optional(),
  autoMerge: z.boolean().optional(),
});

function sealed(value: string | null | undefined, cipher: string, hint: string) {
  if (value === undefined) return {};
  if (value === null) return { [cipher]: null, [hint]: null };
  return { [cipher]: seal(value), [hint]: hintFor(value) };
}

/** The project if this person owns it; otherwise the refusal to send. */
async function ownedProject(user: UserRecord, projectId: string | null) {
  const project = projectId ? await repository().projectById(projectId) : null;
  if (!project || !canSee(user, project.ownerId)) {
    return { refusal: Response.json({ error: "Not your project." }, { status: 403 }) };
  }
  return { project };
}

/** A project's settings. */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const found = await ownedProject(user, new URL(req.url).searchParams.get("projectId"));
  if (found.refusal) return found.refusal;
  return Response.json({ autoMerge: found.project.autoMerge });
}

/** Saves this person's sandbox key. Never returns it. */
export async function PUT(req: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const body = bodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return Response.json({ error: body.error.issues[0]?.message ?? "Malformed." }, { status: 400 });
  }

  if ((body.data.autoMerge === undefined) !== (body.data.projectId === undefined)) {
    return Response.json({ error: "autoMerge and projectId go together." }, { status: 400 });
  }
  if (body.data.projectId !== undefined && body.data.autoMerge !== undefined) {
    const found = await ownedProject(user, body.data.projectId);
    if (found.refusal) return found.refusal;
    await repository().setAutoMerge(found.project.id, body.data.autoMerge);
    return Response.json({ autoMerge: body.data.autoMerge });
  }

  const updated = await repository().updateUser(user.id, {
    ...sealed(body.data.e2bKey, "e2bKeyCipher", "e2bKeyHint"),
  });
  return Response.json({ e2bKeyHint: updated.e2bKeyHint });
}
