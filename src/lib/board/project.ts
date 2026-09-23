import "server-only";

import { cookies } from "next/headers";
import { repository } from "@/lib/db";
import type { ProjectSummary } from "@/lib/db/repository";

/**
 * Which repository this browser is working on.
 *
 * A cookie rather than a path segment: every board route (the page, the
 * event stream, moves, captures) reads the same choice without each one
 * growing a project id, and switching is one write.
 */
export const PROJECT_COOKIE = "formic_project";

export async function activeProject(): Promise<ProjectSummary> {
  const repo = repository();
  const chosen = (await cookies()).get(PROJECT_COOKIE)?.value;
  if (chosen) {
    const project = await repo.projectById(chosen);
    if (project) return project;
  }
  return repo.defaultProject();
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
