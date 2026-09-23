import "server-only";

import { cookies } from "next/headers";
import { repository } from "@/lib/db";
import type { ProjectSummary } from "@/lib/db/repository";
import { authMode } from "@/lib/auth/session";
import { canSee, currentUser, ownerScope } from "@/lib/auth/user";

/**
 * Which repository this browser is working on.
 *
 * A cookie rather than a path segment: every board route (the page, the
 * event stream, moves, captures) reads the same choice without each one
 * growing a project id, and switching is one write. The cookie only picks
 * among the signed-in person's own projects; it cannot open anyone else's.
 */
export const PROJECT_COOKIE = "formic_project";

/**
 * The project this request is about, or null when the person has not picked
 * a repository yet (or is not signed in).
 */
export async function activeProject(): Promise<ProjectSummary | null> {
  const user = await currentUser();
  if (!user) return null;
  const repo = repository();

  const chosen = (await cookies()).get(PROJECT_COOKIE)?.value;
  if (chosen) {
    const project = await repo.projectById(chosen);
    if (project && canSee(user, project.ownerId)) return project;
  }

  const mine = await repo.listProjects(ownerScope(user));
  if (mine[0]) return mine[0];
  // Local mode always has a board to show: the demo one.
  return authMode() === "local" ? repo.defaultProject() : null;
}

/** For API routes: the response to send when there is no project to act on. */
export function noProject(): Response {
  return Response.json(
    { error: "Pick a repository first." },
    { status: 409 },
  );
}

/**
 * The project a card's pipeline runs against. Pipelines are handed a project
 * id rather than reading the cookie: they run after the request that started
 * them, and the browser may have switched repositories by then.
 */
export async function projectFor(projectId: string): Promise<ProjectSummary> {
  const repo = repository();
  return (await repo.projectById(projectId)) ?? repo.defaultProject();
}
