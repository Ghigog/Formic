import { repository } from "@/lib/db";
import { savePreset } from "@/lib/agents/presets";
import { parsePreset } from "../validate";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  if (!(await repository().presetForRun(id))) {
    return Response.json({ error: "That agent no longer exists." }, { status: 404 });
  }
  const body = await parsePreset(req);
  if (!body.ok) return Response.json({ error: body.error }, { status: 400 });
  const preset = await savePreset({ ...body.data, id });
  return Response.json({ preset });
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  await repository().deletePreset(id);
  return new Response(null, { status: 204 });
}
