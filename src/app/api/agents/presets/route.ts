import { savePreset } from "@/lib/agents/presets";
import { parsePreset } from "./validate";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await parsePreset(req);
  if (!body.ok) return Response.json({ error: body.error }, { status: 400 });
  const preset = await savePreset(body.data);
  return Response.json({ preset }, { status: 201 });
}
