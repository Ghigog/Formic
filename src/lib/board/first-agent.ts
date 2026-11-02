import "server-only";

import { repository } from "@/lib/db";
import type { ProjectSummary } from "@/lib/db/repository";
import { addDesignTicket, addOnboardingTicket } from "./onboarding";

/**
 * Whether anything on this board runs an agent: a column's, or the PM's.
 * Either one runs in the repository's GitHub Actions, so either one needs
 * the setup pull request merged first.
 */
export async function boardHasAgent(projectId: string): Promise<boolean> {
  const repo = repository();
  if (Object.keys(await repo.columnAgents(projectId)).length > 0) return true;
  return (await repo.assistantAgent(projectId)) !== null;
}

/**
 * After an agent is picked, for a column or the PM. The first one on a board
 * is what makes it cost anything, so only then is the repository set up: the
 * board asks /api/runner/setup straight after, which opens the setup pull
 * request and shows it. New boards already have their AGENTS.md and DESIGN.md
 * tickets; adding them here covers older boards.
 */
export async function afterAgentPicked(project: ProjectSummary, hadAgent: boolean): Promise<void> {
  if (hadAgent || !project.repoFullName || !(await boardHasAgent(project.id))) return;
  await addOnboardingTicket(project.id);
  await addDesignTicket(project.id);
}
