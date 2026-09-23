import { savePreset } from "@/lib/agents/presets";
import { currentUser } from "@/lib/auth/user";
import { parsePreset } from "./validate";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const body = await parsePreset(req);
  if (!body.ok) return Response.json({ error: body.error }, { status: 400 });
  const preset = await savePreset({ ...body.data, ownerId: user.id });
  return Response.json({ preset }, { status: 201 });
}
