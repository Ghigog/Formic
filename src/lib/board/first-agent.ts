import "server-only";

import { repository } from "@/lib/db";
import type { ProjectSummary } from "@/lib/db/repository";
import { provider as providerInfo } from "@/lib/llm/providers";
import { addDesignTicket, addOnboardingTicket } from "./onboarding";

/**
 * Whether anything on this board runs an agent: a column's, or the PM's.
 * Either one runs in the repository's GitHub Actions, so either one needs
 * the setup pull request merged first (or, for agents on API keys, the
 * person's own E2B key).
 */
export async function boardHasAgent(projectId: string): Promise<boolean> {
  const repo = repository();
  if (Object.keys(await repo.columnAgents(projectId)).length > 0) return true;
  return (await repo.assistantAgent(projectId)) !== null;
}

/**
 * Whether an agent on this board runs on a plan (Claude Code, Codex, Gemini
 * CLI). Those run only in the repository's GitHub Actions; agents on API keys
 * can run in E2B sandboxes instead.
 */
export async function boardHasCliAgent(projectId: string): Promise<boolean> {
  const repo = repository();
  const ids = [...Object.values(await repo.columnAgents(projectId)), await repo.assistantAgent(projectId)];
  for (const id of ids) {
    if (!id) continue;
    const found = await repo.presetForRun(id);
    if (found && providerInfo(found.preset.provider)?.kind === "cli") return true;
  }
  return false;
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
