import "server-only";

import { repository } from "@/lib/db";
import { passRate, projectKpis, timeline, type KpiWindow } from "./compute";

export type { KpiWindow } from "./compute";

/** The project's KPIs. Scouts are not board cards, so they never count. */
export async function kpisFor(projectId: string, window: KpiWindow, now = new Date()) {
  const repo = repository();
  const cards = (await repo.boardCards(projectId)).filter((c) => c.kind === "ticket" || c.kind === "epic");
  const workByCard = await repo.cardTokenWork(cards.map((c) => ({ kind: c.kind as "epic" | "ticket", id: c.id })));
  const tickets = cards.filter((c) => c.kind === "ticket");
  const epicWork = cards.filter((c) => c.kind === "epic").flatMap((c) => workByCard.get(c.id) ?? []);
  const histories = await Promise.all(
    tickets.map(async (t) => ({
      ticket: {
        id: t.id,
        key: t.key,
        title: t.title,
        storyPoints: t.storyPoints ?? null,
        costCents: t.costCents,
        attempts: (await repo.ticketDetail(t.id))?.attempts ?? 0,
      },
      entries: await repo.ticketColumnEntries(t.id),
      changes: await repo.ticketChanges(t.id),
      work: workByCard.get(t.id) ?? [],
    })),
  );
  return projectKpis(histories, window, now, epicWork);
}

/** One ticket's timeline with durations, its review pass rate and how many times it changed after spec; null when it is not in the project. */
export async function ticketKpisFor(projectId: string, ticketId: string, now = new Date()) {
  const repo = repository();
  if ((await repo.projectOfCard(ticketId)) !== projectId) return null;
  const [entries, changes] = await Promise.all([repo.ticketColumnEntries(ticketId), repo.ticketChanges(ticketId)]);
  return {
    id: ticketId,
    entries: timeline(entries, now),
    passRate: passRate(entries),
    changesAfterSpec: changes.length,
  };
}
