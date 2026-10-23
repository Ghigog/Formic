import "server-only";

import { repository } from "@/lib/db";
import type { FormicEvent } from "@/lib/domain/events";
import { sendPush } from "@/lib/push/send";
import { classifyEvent } from "./classify";

/**
 * Pushes a board event to the board's owner, when it is worth one and they
 * have that kind switched on. Never throws: a push failure must not fail the
 * event that caused it.
 */
export async function notifyOwner(projectId: string, event: FormicEvent): Promise<void> {
  try {
    if (event.type !== "card.status" && event.type !== "budget.exhausted") return;
    const repo = repository();
    const project = await repo.projectById(projectId);
    if (!project?.ownerId) return;

    let cardKey = "";
    let cardTitle = "";
    if (event.type === "card.status") {
      const card = await repo.cardById(event.cardId);
      if (!card) return;
      cardKey = card.key;
      cardTitle = card.title;
    }
    const notification = classifyEvent(event, { cardKey, cardTitle, boardName: project.name });
    if (!notification) return;

    const prefs = await repo.pushPreferences(project.ownerId);
    if (!prefs[notification.kind]) return;
    await sendPush(project.ownerId, notification);
  } catch {
    // Best-effort, like every other subscriber of the bus.
  }
}
