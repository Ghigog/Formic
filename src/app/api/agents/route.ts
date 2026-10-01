import { repository } from "@/lib/db";
import { activeProject } from "@/lib/board/project";
import { currentUser, ownerScope } from "@/lib/auth/user";
import { tokenWindow } from "@/lib/token-window";

export const dynamic = "force-dynamic";

/** This person's saved presets, which one each column runs, and what each has used. */
export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const repo = repository();
  const project = await activeProject();
  const window = tokenWindow(
    {
      renewalDay: user.tokenRenewalDay,
      timezone: user.tokenWindowTimezone,
      resetAt: user.tokenResetAt,
    },
    new Date(),
  );
  const [presets, columns, usage] = await Promise.all([
    repo.listPresets(ownerScope(user)),
    project ? repo.columnAgents(project.id) : {},
    repo.agentTokensByPreset(window.since),
  ]);
  return Response.json({
    presets,
    columns,
    usage,
    window: {
      kind: window.kind,
      since: window.since?.toISOString() ?? null,
      timezone: user.tokenWindowTimezone,
    },
  });
}
