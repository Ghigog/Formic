import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { repository } from "@/lib/db";

/**
 * Whose keys the work in hand runs on.
 *
 * A shared board has one owner and any number of members (src/lib/board/
 * sharing.ts). Each person's work runs on their own keys and agents: their
 * E2B key, their GitHub token, the agents they picked for each column. Only
 * when the owner turns on shareKeys does a member with none of their own
 * fall back to the owner's.
 *
 * A card remembers who set it going (`actorId`), so its work keeps running on
 * that person's keys after the request that started it has ended: a CI
 * result arriving by webhook, a run collected by someone else's open board,
 * a queued ticket starting when another finishes. Work with no card, such as
 * repository setup or issue import, runs as the owner, as it always has.
 *
 * Async-local, so it reaches every key lookup the work makes and nothing else.
 */
const acting = new AsyncLocalStorage<{ userId: string | null }>();

/** Runs work on someone's keys. Null is the board's owner. */
export function withActor<T>(userId: string | null, work: () => T): T {
  return acting.run({ userId }, work);
}

/** Who the work in hand runs as, or null for the board's owner. */
export function actingUserId(): string | null {
  return acting.getStore()?.userId ?? null;
}

/** Runs a card's work on the keys of whoever set it going. */
export async function withCardActor<T>(cardId: string, work: () => Promise<T>): Promise<T> {
  return withActor(await repository().cardActor(cardId), work);
}

/**
 * Marks a card as set going by whoever is acting now, so its work, including
 * what follows after this request, runs on their keys. Work with nobody
 * acting (a sweep, a webhook) leaves the card as it was.
 */
export async function startedBy(cardId: string): Promise<void> {
  const userId = actingUserId();
  if (userId) await repository().setCardActor(cardId, userId);
}

/**
 * The actor now, to carry into work that runs later, outside this async
 * context (Next's `after`).
 */
export function carryActor(): <T>(work: () => T) => T {
  const store = acting.getStore();
  return (work) => (store ? acting.run(store, work) : work());
}
