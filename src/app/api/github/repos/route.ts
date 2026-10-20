import { currentUser } from "@/lib/auth/user";
import { credentialsFor } from "@/lib/auth/credentials";
import { installUrl } from "@/lib/auth/github";
import { authMode } from "@/lib/auth/session";
import { NextRequest } from "next/server";
import { z } from "zod";
import { createRepository, listRepositories, REPO_NAME } from "@/lib/vcs/repositories";
import { limited, RUN } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** What the repository picker offers this person, and where to grant more. */
export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });

  const install = installUrl();
  const { githubToken, githubTokenKind } = await credentialsFor(user);
  if (!githubToken || !githubTokenKind) {
    return Response.json({
      ok: false,
      reason:
        authMode() === "github"
          ? "Your GitHub sign-in has lapsed. Sign out and back in."
          : "Set GITHUB_TOKEN to list your repositories. You can still type owner/repo.",
      installUrl: install,
    });
  }

  const result = await listRepositories(githubToken, githubTokenKind);
  return Response.json({ ...result, installUrl: install });
}

const createSchema = z.object({ name: z.string().regex(REPO_NAME) });

/** Create a new repository on this person's GitHub account. */
export async function POST(req: NextRequest) {
  const refused = limited(req, RUN, "repo-create");
  if (refused) return refused;

  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "Use letters, numbers, dots, dashes or underscores." },
      { status: 400 },
    );
  }

  const { githubToken } = await credentialsFor(user);
  if (!githubToken) {
    return Response.json({ error: "Connect GitHub to create repositories." }, { status: 400 });
  }

  const result = await createRepository(parsed.data.name, githubToken);
  if (!result.ok) return Response.json({ error: result.reason }, { status: 422 });
  return Response.json({ repo: result.repo });
}
