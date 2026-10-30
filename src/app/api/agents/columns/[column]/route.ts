import { z } from "zod";
import { activeProject, noProject } from "@/lib/board/project";
import { currentUser } from "@/lib/auth/user";
import { ownsPreset } from "../../presets/validate";
import { COLUMNS } from "@/lib/domain/status";
import { agentView, assignAgent } from "@/lib/agents/board-agents";
import { launch } from "@/lib/agents/pipeline";
import { addDesignTicket, addOnboardingTicket } from "@/lib/board/onboarding";
import { repository } from "@/lib/db";
import { runnerSetup } from "@/lib/runner/setup";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ presetId: z.string().min(1).nullable() });

/**
 * Which preset runs this column on the active board, for this person: the
 * board's own for its owner, their own for a member (see board-agents.ts).
 * Null means none.
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ column: string }> },
) {
  const { column } = await params;
  const col = z.enum(COLUMNS).safeParse(column);
  const body = bodySchema.safeParse(await req.json().catch(() => null));
  if (!col.success || !body.success) {
    return Response.json({ error: "Expected a column and a presetId (or null)." }, { status: 400 });
  }

  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  if (body.data.presetId && !(await ownsPreset(user, body.data.presetId))) {
    return Response.json({ error: "That agent no longer exists." }, { status: 404 });
  }


  const project = await activeProject();
  if (!project) return noProject();
  const hadAgent = Object.keys(await repository().columnAgents(project.id)).length > 0;
  await assignAgent(project, user, col.data, body.data.presetId);
  // The first agent on a board is what makes it cost anything: only now does
  // its repository get the setup pull request. New boards already have their
  // AGENTS.md and DESIGN.md tickets; adding them here covers older boards.
  if (!hadAgent && project.repoFullName && Object.keys(await repository().columnAgents(project.id)).length > 0) {
    await addOnboardingTicket(project.id);
    await addDesignTicket(project.id);
    launch(async () => void (await runnerSetup(project)), `setting up ${project.repoFullName}`);
  }
  return Response.json({ columns: (await agentView(project, user)).columns });
}
