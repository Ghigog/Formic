import { repository } from "@/lib/db";
import { saveTokenToRepo } from "@/lib/agents/agent-secret";
import { savePreset } from "@/lib/agents/presets";
import { currentUser } from "@/lib/auth/user";
import { VaultKeyMissingError } from "@/lib/secrets/vault";
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
  // A preset with a column already keeps it: savePreset only honours
  // `column` here for one made before columns were scoped (still null).
  try {
    const preset = await savePreset({ ...body.data, id });
    // A Claude Code token pasted here also becomes the repository secret its CI jobs sign in with.
    const secret = typeof body.data.apiKey === "string" ? await saveTokenToRepo(user, preset, body.data.apiKey) : null;
    return Response.json({ preset, ...(secret && { secret }) });
  } catch (error) {
    if (error instanceof VaultKeyMissingError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  if (!(await ownsPreset(user, id))) return gone();
  await repository().deletePreset(id);
  return new Response(null, { status: 204 });
}
