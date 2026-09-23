import { repository } from "@/lib/db";
import { savePreset } from "@/lib/agents/presets";
import { currentUser } from "@/lib/auth/user";
import { ownsPreset, parsePreset } from "../validate";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const gone = () => Response.json({ error: "That agent no longer exists." }, { status: 404 });

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  if (!(await ownsPreset(user, id))) return gone();
  const body = await parsePreset(req);
  if (!body.ok) return Response.json({ error: body.error }, { status: 400 });
  const preset = await savePreset({ ...body.data, id });
  return Response.json({ preset });
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  if (!(await ownsPreset(user, id))) return gone();
  await repository().deletePreset(id);
  return new Response(null, { status: 204 });
}
