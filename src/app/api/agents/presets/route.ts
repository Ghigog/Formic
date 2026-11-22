import { saveTokenToRepo } from "@/lib/agents/agent-secret";
import { savePreset } from "@/lib/agents/presets";
import { currentUser } from "@/lib/auth/user";
import { VaultKeyMissingError } from "@/lib/secrets/vault";
import { parsePreset } from "./validate";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const body = await parsePreset(req);
  if (!body.ok) return Response.json({ error: body.error }, { status: 400 });
  try {
    const preset = await savePreset({ ...body.data, ownerId: user.id });
    const secret = typeof body.data.apiKey === "string" ? await saveTokenToRepo(user, preset, body.data.apiKey) : null;
    return Response.json({ preset, ...(secret && { secret }) }, { status: 201 });
  } catch (error) {
    if (error instanceof VaultKeyMissingError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
