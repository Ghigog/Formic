import { z } from "zod";
import { repository } from "@/lib/db";
import { canSee, currentUser } from "@/lib/auth/user";
import { canSeeBoard } from "@/lib/board/sharing";
import { credentialsForProject } from "@/lib/auth/credentials";
import { vcs } from "@/lib/vcs";
import { ESTABLISHED_COMMITS, isEstablished } from "@/lib/sentinels/roster";
import type { ProjectSummary } from "@/lib/db/repository";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * The commits on the base branch, and whether that history makes the project
 * established. Null when GitHub cannot be reached or there is no repository:
 * the count is a hint for the owner, not something to fail the read over.
 */
async function history(project: ProjectSummary) {
  const commits = await countBaseCommits(project);
  return {
    baseBranchCommits: commits,
    established: commits === null ? false : isEstablished(commits),
    establishedThreshold: ESTABLISHED_COMMITS,
  };
}

async function countBaseCommits(project: ProjectSummary): Promise<number | null> {
  if (!project.repoFullName) return null;
  try {
    const { githubToken } = await credentialsForProject(project);
    return await vcs(project.repoFullName, githubToken).countCommits(project.baseBranch);
  } catch {
    return null;
  }
}

async function view(project: ProjectSummary) {
  return {
    id: project.id,
    unlockAllSentinels: project.unlockAllSentinels,
    unlockAllOfferDismissedAt: project.unlockAllOfferDismissedAt?.toISOString() ?? null,
    ...(await history(project)),
  };
}

/** A project's Sentinel unlocking and the base-branch history that suggests it. */
export async function GET(_req: Request, { params }: Params) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const project = await repository().projectById((await params).id);
  if (!project || !(await canSeeBoard(user, project))) {
    return Response.json({ error: "That project no longer exists." }, { status: 404 });
  }
  return Response.json(await view(project));
}

const patchSchema = z.union([
  z.object({ unlockAllSentinels: z.boolean() }),
  z.object({ unlockAllOfferDismissed: z.literal(true) }),
]);

/**
 * Turns the unlocking of every Sentinel on or off (owner only), or records
 * that the offer to do so was dismissed (anyone who can see the board).
 */
export async function PATCH(req: Request, { params }: Params) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const project = await repository().projectById((await params).id);
  if (!project) return Response.json({ error: "That project no longer exists." }, { status: 404 });
  const body = patchSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return Response.json(
      { error: "Expected unlockAllSentinels as true or false, or unlockAllOfferDismissed as true." },
      { status: 400 },
    );
  }
  if ("unlockAllOfferDismissed" in body.data) {
    if (!(await canSeeBoard(user, project))) {
      return Response.json({ error: "That project no longer exists." }, { status: 404 });
    }
    await repository().setUnlockAllOfferDismissed(project.id);
    const updated = (await repository().projectById(project.id)) ?? project;
    return Response.json(await view(updated));
  }
  if (!canSee(user, project.ownerId)) {
    return Response.json({ error: "Not your project." }, { status: 403 });
  }
  await repository().setUnlockAllSentinels(project.id, body.data.unlockAllSentinels);
  return Response.json(await view({ ...project, unlockAllSentinels: body.data.unlockAllSentinels }));
}
