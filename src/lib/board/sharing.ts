import "server-only";

import { repository } from "@/lib/db";
import type { ProjectSummary, UserRecord } from "@/lib/db/repository";
import { authMode } from "@/lib/auth/session";
import { credentialsFor } from "@/lib/auth/credentials";
import { getRepository } from "@/lib/vcs/repositories";

/**
 * One board per repository, shared by everyone who can reach it on GitHub.
 *
 * The board is the repository's oldest one with an owner. Anyone else who
 * opens the repository joins it as a member: they see every card, and their
 * runs use their own keys and agents (see ../auth/actor.ts). A board someone
 * made for the same repository before boards were shared is left as it was,
 * and simply stops being the one they land on.
 *
 * Local mode has one person and no sharing.
 */

/** The board everyone on a repository shares: its oldest one with an owner. */
export async function sharedBoard(repoFullName: string): Promise<ProjectSummary | null> {
  return (await repository().projectsForRepo(repoFullName)).find((p) => p.ownerId !== null) ?? null;
}

/** Whether this person can see a board: they own it, or it is shared with them. */
export async function canSeeBoard(user: UserRecord, project: ProjectSummary): Promise<boolean> {
  if (project.ownerId === user.id) return true;
  if (project.ownerId === null) return authMode() === "local";
  return authMode() === "github" && repository().isMember(project.id, user.id);
}

/** Whether this person's own GitHub access reaches a repository. */
export async function canReach(user: UserRecord, repoFullName: string): Promise<boolean> {
  const { githubToken } = await credentialsFor(user);
  return !!githubToken && (await getRepository(repoFullName, githubToken)) !== null;
}

/**
 * The board this person belongs on for a board of theirs: the shared one on
 * its repository when someone else's came first, joined the first time their
 * GitHub access is seen to reach it. Otherwise the board itself.
 */
export async function boardFor(user: UserRecord, project: ProjectSummary): Promise<ProjectSummary> {
  if (authMode() !== "github" || project.ownerId !== user.id) return project;
  const shared = await sharedBoard(project.repoFullName);
  if (!shared || shared.id === project.id) return project;
  const repo = repository();
  if (await repo.isMember(shared.id, user.id)) return shared;
  if (!(await canReach(user, shared.repoFullName))) return project;
  await repo.addMember(shared.id, user.id);
  return shared;
}

/**
 * Every board this person can open: their own, and those shared with them.
 * A board of their own on a repository whose shared board they have joined
 * is left out, so each repository shows once.
 */
export async function boardsFor(user: UserRecord, own: ProjectSummary[]): Promise<ProjectSummary[]> {
  if (authMode() !== "github") return own;
  const shared = await repository().memberProjects(user.id);
  const joined = new Set(shared.map((p) => p.repoFullName.toLowerCase()));
  return [...own.filter((p) => !joined.has(p.repoFullName.toLowerCase())), ...shared];
}
