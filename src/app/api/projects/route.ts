import { NextRequest } from "next/server";
import { z } from "zod";
import { repository } from "@/lib/db";
import { PROJECT_COOKIE, activeProject } from "@/lib/board/project";
import { canSee, currentUser, ownerScope } from "@/lib/auth/user";
import { credentialsFor } from "@/lib/auth/credentials";
import { authMode, cookieHeader } from "@/lib/auth/session";
import { normalizeRepo } from "@/lib/secrets/repo";
import { getRepository } from "@/lib/vcs/repositories";

export const dynamic = "force-dynamic";

/** This person's projects, and which one this browser is looking at. */
export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const [active, projects] = await Promise.all([
    activeProject(),
    repository().listProjects(ownerScope(user)),
  ]);
  return Response.json({ active, projects });
}

const chooseSchema = z.union([
  z.object({ projectId: z.string().min(1) }),
  z.object({ repoFullName: z.string().min(1) }),
]);

/**
 * Switch this browser to a project: one of this person's by id, or a
 * repository by name, which creates their project for it the first time.
 */
export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });

  const parsed = chooseSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Expected a projectId or a repoFullName." }, { status: 400 });
  }

  const repo = repository();
  let project;
  if ("projectId" in parsed.data) {
    project = await repo.projectById(parsed.data.projectId);
    if (!project || !canSee(user, project.ownerId)) {
      return Response.json({ error: "That project no longer exists." }, { status: 404 });
    }
  } else {
    const fullName = normalizeRepo(parsed.data.repoFullName);
    if (!fullName) {
      return Response.json(
        { error: "Use owner/repo, or paste the repository URL." },
        { status: 400 },
      );
    }
    // Signed in with GitHub, a repository must be one this person's token
    // can reach: that is what their agents will push with. In local mode a
    // typed name is taken on trust, as before.
    const { githubToken } = await credentialsFor(user);
    const remote = githubToken ? await getRepository(fullName, githubToken) : null;
    if (!remote && authMode() === "github") {
      return Response.json(
        {
          error: `Formic can't reach ${fullName}. Install the Formic GitHub App on it first.`,
        },
        { status: 404 },
      );
    }
    project = await repo.ensureProject({
      ownerId: user.id,
      repoFullName: remote?.fullName ?? fullName,
      baseBranch: remote?.defaultBranch ?? "main",
    });
  }

  const res = Response.json({ project });
  res.headers.append(
    "Set-Cookie",
    cookieHeader(PROJECT_COOKIE, encodeURIComponent(project.id), 31536000),
  );
  return res;
}
