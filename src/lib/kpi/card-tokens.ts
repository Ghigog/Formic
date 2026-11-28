import "server-only";

import { repository } from "@/lib/db";
import { tokensByStay, type StayTokens } from "./tokens";

export interface CardTokens {
  stays: StayTokens[];
  totalIn: number;
  totalOut: number;
  /** Some answer came from an agent that reports no tokens. */
  unreported: boolean;
}

/** The tokens a card used in each column stay, and in all; null when it is not in the project. */
export async function cardTokensFor(
  projectId: string,
  kind: "ticket" | "epic",
  id: string,
): Promise<CardTokens | null> {
  const repo = repository();
  if ((await repo.projectOfCard(id)) !== projectId) return null;
  const [entries, work] = await Promise.all([
    kind === "epic" ? repo.epicColumnEntries(id) : repo.ticketColumnEntries(id),
    repo.cardTokenWork([{ kind, id }]),
  ]);
  const stays = tokensByStay(entries, work.get(id) ?? []);
  return {
    stays,
    totalIn: stays.reduce((n, s) => n + s.tokensIn, 0),
    totalOut: stays.reduce((n, s) => n + s.tokensOut, 0),
    unreported: stays.some((s) => s.unreported),
  };
}
