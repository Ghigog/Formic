import "server-only";

import { repository } from "@/lib/db";
import type { FormicEvent } from "@/lib/domain/events";
import { classifyNotice, isUsageLimitStop } from "@/lib/domain/notice";
import type { ColumnId, TicketStatus } from "@/lib/domain/status";
import { postPmMessage } from "./pm-messages";

type CardStatus = FormicEvent & { type: "card.status" };

declare global {
  var __formicStallsReported: Map<string, string> | undefined;
}

/** The status and reason of the stall each card last had the person told about. */
function reported(): Map<string, string> {
  return (globalThis.__formicStallsReported ??= new Map());
}

/** Forgets what was reported, for tests. */
export function resetStallsReported(): void {
  reported().clear();
}

function stallOf(event: Pick<CardStatus, "status" | "blockedReason">): string | null {
  return event.status === "blocked" || event.status === "failed" ? `${event.status}|${event.blockedReason ?? ""}` : null;
}

/**
 * The PM tells the person in the board chat when a ticket stops on something
 * only they can resolve: a question, a step that needs them, a stall the
 * agents gave up on. Usage-limit stops clear on their own and are not
 * reported. The same stall twice is reported once. Never throws.
 */
export async function reportStall(projectId: string, event: FormicEvent, seq?: number): Promise<void> {
  try {
    if (event.type !== "card.status") return;
    const stall = stallOf(event);
    const remembered = reported().get(event.cardId);
    let was = remembered;
    if (was === undefined && seq !== undefined) {
      const previous = (await repository()
        .cardStatusBefore(projectId, event.cardId, seq)
        .catch(() => null)) as CardStatus | null;
      was = (previous?.status ? stallOf(previous) : null) ?? undefined;
    }
    // Remember every status, so a stall that clears and comes back is new.
    reported().set(event.cardId, stall ?? "");
    if (!stall || stall === was) return;

    const card = await repository().cardById(event.cardId);
    if (!card) return;
    const state = {
      status: event.status as TicketStatus,
      stalledIn: event.stalledIn as ColumnId | null,
      blockedReason: event.blockedReason,
      workingSince: card.workingSince,
    };
    const notice = classifyNotice(state);
    if (!notice || isUsageLimitStop(state)) return;

    const needs =
      notice.severity === "question"
        ? `It asks: ${notice.shortDescription} Answer in the card's chat.`
        : notice.longDescription;
    const head = `${card.key} · ${card.title} needs you: ${notice.title}.`;
    const content =
      notice.severity === "question"
        ? `${head}\n\n${needs}`
        : [head, notice.shortDescription, needs].filter(Boolean).join("\n\n");
    await postPmMessage(projectId, { content, cards: [{ id: card.id, key: card.key, title: card.title }] });
  } catch (e) {
    console.error("[formic] PM stall message failed:", e);
  }
}
