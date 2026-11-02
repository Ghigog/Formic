import { z } from "zod";

import { currentUser } from "@/lib/auth/user";
import { activeProject, noProject } from "@/lib/board/project";
import { assignAgent } from "@/lib/agents/board-agents";
import { afterAgentPicked, boardHasAgent } from "@/lib/board/first-agent";
import { ownsPreset } from "../../agents/presets/validate";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ presetId: z.string().min(1).nullable() });

/** Which saved agent the assistant runs on for the active board. */
export async function PUT(req: Request) {
  const body = bodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Expected a presetId (or null)." }, { status: 400 });

  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  if (body.data.presetId && !(await ownsPreset(user, body.data.presetId))) {
    return Response.json({ error: "That agent no longer exists." }, { status: 404 });
  }
  const project = await activeProject();
  if (!project) return noProject();

  // The PM runs in the repository's Actions too: picking it first sets the
  // board up exactly as a column's first agent does.
  const hadAgent = await boardHasAgent(project.id);
  await assignAgent(project, user, "assistant", body.data.presetId);
  await afterAgentPicked(project, hadAgent);
  return Response.json({ presetId: body.data.presetId });
}
