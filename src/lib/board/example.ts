import "server-only";

import { repository } from "@/lib/db";
import type { ProjectSummary } from "@/lib/db/repository";
import { publish } from "@/lib/events/bus";
import { addOnboardingTicket } from "./onboarding";

/**
 * The example project: a board with no repository behind it, for a first
 * timer to try Formic on without touching their own code. It starts with the
 * same AGENTS.md ticket a real board does, so the guided tour has its ticket
 * to point at, and a few ideas in the Backlog so the columns are not bare.
 */
export const EXAMPLE_PROJECT_NAME = "Example project";

export const EXAMPLE_IDEAS = [
  "Add a dark mode toggle to the settings page",
  "Show a friendly empty state when a list has nothing in it",
  "Let people sort the list by date or by name",
] as const;

/** This person's example board: the one they already have, or a new one. */
export async function openExampleProject(ownerId: string): Promise<ProjectSummary> {
  const repo = repository();
  const existing = (await repo.listProjects({ ownerId, includeUnowned: false })).find(
    (p) => p.ownerId === ownerId && !p.repoFullName && p.name === EXAMPLE_PROJECT_NAME,
  );
  if (existing) return existing;

  const project = await repo.ensureProject({
    ownerId,
    repoFullName: null,
    name: EXAMPLE_PROJECT_NAME,
    baseBranch: "main",
  });
  await addOnboardingTicket(project.id);
  for (const [i, title] of EXAMPLE_IDEAS.entries()) {
    const epic = await repo.createEpic({
      projectId: project.id,
      title,
      rawRequest: title,
      position: (i + 1) * 1000,
    });
    await publish(project.id, { type: "card.created", cardId: epic.id, kind: "epic", epicId: null });
  }
  return project;
}
