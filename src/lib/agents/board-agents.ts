import "server-only";

import { repository } from "@/lib/db";
import type { ProjectSummary, UserRecord } from "@/lib/db/repository";
import type { AgentPreset, ColumnAgents } from "@/lib/domain/entities";
import type { ColumnId } from "@/lib/domain/status";
import { authMode } from "@/lib/auth/session";
import { ownerScope } from "@/lib/auth/user";

/**
 * The agents a person sees and picks on a board. The owner's picks are the
 * board's own. On a shared board a member picks their own, from their own
 * saved agents, and those are what their runs use (./presets.ts). When the
 * owner shares keys, the owner's pick shows on any column the member left
 * empty, since that is what their runs fall back to.
 */

/** Whether this person is a member of the board, not its owner. */
function memberOf(project: ProjectSummary, user: UserRecord): boolean {
  return authMode() === "github" && project.ownerId !== null && project.ownerId !== user.id;
}

export interface AgentView {
  presets: AgentPreset[];
  columns: ColumnAgents;
  assistant: string | null;
}

export async function agentView(project: ProjectSummary | null, user: UserRecord): Promise<AgentView> {
  const repo = repository();
  const own = await repo.listPresets(ownerScope(user));
  if (!project) return { presets: own, columns: {}, assistant: null };
  const boardColumns = await repo.columnAgents(project.id);
  const boardAssistant = await repo.assistantAgent(project.id);
  if (!memberOf(project, user)) return { presets: own, columns: boardColumns, assistant: boardAssistant };

  const mine = await repo.memberAgents(project.id, user.id);
  const { assistant = null, ...columns } = mine;
  if (!project.shareKeys) return { presets: own, columns: columns as ColumnAgents, assistant };

  const lentColumns = { ...boardColumns, ...columns } as ColumnAgents;
  const lentAssistant = assistant ?? boardAssistant;
  const lentIds = new Set([...Object.values(lentColumns), lentAssistant].filter((id): id is string => !!id));
  const ownerPresets = project.ownerId
    ? (await repo.listPresets({ ownerId: project.ownerId, includeUnowned: false })).filter((p) => lentIds.has(p.id))
    : [];
  return { presets: [...own, ...ownerPresets], columns: lentColumns, assistant: lentAssistant };
}

/** The PM's agent as this person sees the board. */
export async function assistantPick(project: ProjectSummary, user: UserRecord): Promise<string | null> {
  const repo = repository();
  if (!memberOf(project, user)) return repo.assistantAgent(project.id);
  const mine = (await repo.memberAgents(project.id, user.id)).assistant ?? null;
  return mine ?? (project.shareKeys ? repo.assistantAgent(project.id) : null);
}

/** Picks the agent for a column, or "assistant", as this person sees the board. */
export async function assignAgent(
  project: ProjectSummary,
  user: UserRecord,
  slot: ColumnId | "assistant",
  presetId: string | null,
): Promise<void> {
  const repo = repository();
  if (memberOf(project, user)) return repo.setMemberAgent(project.id, user.id, slot, presetId);
  if (slot === "assistant") return repo.setAssistantAgent(project.id, presetId);
  return repo.setColumnAgent(project.id, slot, presetId);
}

/** Whether this person may change the board's own settings, such as column limits. */
export function ownsBoard(project: ProjectSummary, user: UserRecord): boolean {
  return !memberOf(project, user);
}
