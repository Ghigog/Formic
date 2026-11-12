import "server-only";

import { repository } from "@/lib/db";
import { classifyNotice, isUsageLimitStop } from "@/lib/domain/notice";
import type { FormicEvent } from "@/lib/domain/events";
import type { ColumnId, TicketStatus } from "@/lib/domain/status";
import { postPmMessage } from "./pm-messages";

type CardStatus = FormicEvent & { type: "card.status" };

declare global {
  var __formicStallsReported: Map<string, string | null> | undefined;
}

function reported(): Map<string, string | null> {
  return (globalThis.__formicStallsReported ??= new Map());
}

/** Forgets what was reported, for tests. */
export function resetStallsReported(): void {
  reported().clear();
}

/** The stop's status and reason; null while the card is not blocked or failed. */
function stallOf(event: Pick<CardStatus, "status" | "blockedReason">): string | null {
  return event.status === "blocked" || event.status === "failed" ? `${event.status}|${event.blockedReason ?? ""}` : null;
}

/**
 * Tells the person in the board chat when a ticket stops on something only
 * they can resolve: an agent's question, a step that needs a human, or a
 * stall the agents gave up on. A usage-limit stop clears on its own, and a
 * repeat of the same stop says nothing new. Never throws.
 */
export async function reportStall(projectId: string, event: FormicEvent, seq?: number): Promise<void> {
  try {
    if (event.type !== "card.status") return;
    const now = stallOf(event);

    let was = reported().get(event.cardId);
    if (was === undefined && seq !== undefined) {
      // First sight since a restart: the event log says what it was before.
      const previous = (await repository()
        .cardStatusBefore(projectId, event.cardId, seq)
        .catch(() => null)) as CardStatus | null;
      was = previous?.status ? stallOf(previous) : undefined;
    }
    reported().set(event.cardId, now);
    if (now === null || was === now) return;

    const card = await repository().cardById(event.cardId);
    if (!card) return;
    const stopped = {
      status: event.status as TicketStatus,
      stalledIn: event.stalledIn as ColumnId | null,
      blockedReason: event.blockedReason,
      workingSince: card.workingSince,
    };
    const notice = classifyNotice(stopped);
    if (!notice || isUsageLimitStop(stopped)) return;

    const lines = [`${card.key} · ${card.title} needs you: ${notice.title}. ${notice.shortDescription}`];
    if (notice.longDescription) lines.push("", notice.longDescription);
    if (notice.severity === "question") lines.push("", "Answer in the card's chat.");

    await postPmMessage(projectId, {
      content: lines.join("\n"),
      cards: [{ id: card.id, key: card.key, title: card.title }],
    });
  } catch (e) {
    // Best-effort, like every other subscriber of the bus.
    console.error("[formic] PM message about a stalled card failed:", e);
  }
}
