import "server-only";

import { currentUser } from "@/lib/auth/user";
import { activeProject, noProject } from "@/lib/board/project";
import { repository } from "@/lib/db";
import type { AssistantMessage, PlaytestRecord, ProjectSummary, UserRecord } from "@/lib/db/repository";

/** The signed-in person and their active board, or the response that says why not. */
export async function playtestBoard(): Promise<
  { project: ProjectSummary; user: UserRecord } | { error: Response }
> {
  const user = await currentUser();
  if (!user) return { error: Response.json({ error: "Sign in first." }, { status: 401 }) };
  const project = await activeProject();
  if (!project) return { error: noProject() };
  return { project, user };
}

/** A session on the active board; `own` also requires it to be the person's. */
export async function playtestOnBoard(
  id: string,
  own: boolean,
): Promise<{ project: ProjectSummary; user: UserRecord; record: PlaytestRecord } | { error: Response }> {
  const found = await playtestBoard();
  if ("error" in found) return found;
  const record = await repository().playtest(id);
  if (!record || record.projectId !== found.project.id || (own && record.userId !== found.user.id)) {
    return { error: Response.json({ error: "No such playtest." }, { status: 404 }) };
  }
  return { ...found, record };
}

/** A playtest's messages as the screen shows them. */
export function messageView(m: AssistantMessage) {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    status: m.status,
    proposals: m.proposals,
    shots: m.attachments.filter((a) => a.kind === "image").map((a) => ({ id: a.id, url: a.url })),
    createdAt: m.createdAt.toISOString(),
  };
}

export type PlaytestMessageView = ReturnType<typeof messageView>;
