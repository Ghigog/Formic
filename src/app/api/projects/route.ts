import { NextRequest } from "next/server";
import { z } from "zod";
import { repository } from "@/lib/db";
import { PROJECT_COOKIE, activeProject } from "@/lib/board/project";
import { normalizeRepo } from "@/lib/secrets/repo";
import { getRepository } from "@/lib/vcs/repositories";

export const dynamic = "force-dynamic";

/** The projects on this board, and which one this browser is looking at. */
export async function GET() {
  const [active, projects] = await Promise.all([
    activeProject(),
    repository().listProjects(),
  ]);
  return Response.json({ active, projects });
}

const chooseSchema = z.union([
  z.object({ projectId: z.string().min(1) }),
  z.object({ repoFullName: z.string().min(1) }),
]);

/**
 * Switch this browser to a project: an existing one by id, or a repository
 * by name, which creates its project the first time.
 */
export async function POST(req: NextRequest) {
  const parsed = chooseSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Expected a projectId or a repoFullName." }, { status: 400 });
  }

  const repo = repository();
  let project;
  if ("projectId" in parsed.data) {
    project = await repo.projectById(parsed.data.projectId);
    if (!project) {
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
    // The real name and default branch when the token can see it, so the
    // board says "main" or "master" correctly and matches GitHub's casing.
    const remote = await getRepository(fullName);
    project = await repo.ensureProject({
      repoFullName: remote?.fullName ?? fullName,
      baseBranch: remote?.defaultBranch ?? "main",
    });
  }

  const res = Response.json({ project });
  res.headers.append(
    "Set-Cookie",
    `${PROJECT_COOKIE}=${encodeURIComponent(project.id)}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${
      process.env.NODE_ENV === "production" ? "; Secure" : ""
    }`,
  );
  return res;
}
