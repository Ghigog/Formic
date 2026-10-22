import "server-only";

import { repository } from "@/lib/db";
import { passRate, precision, projectKpis, timeline, type KpiWindow } from "./compute";

export type { KpiWindow } from "./compute";

/** The project's KPIs. Scouts are not board cards, so they never count. */
export async function kpisFor(projectId: string, window: KpiWindow, now = new Date()) {
  const repo = repository();
  const tickets = (await repo.boardCards(projectId)).filter((c) => c.kind === "ticket");
  const histories = await Promise.all(
    tickets.map(async (t) => ({
      entries: await repo.ticketColumnEntries(t.id),
      changes: await repo.ticketChanges(t.id),
    })),
  );
  return projectKpis(histories, window, now);
}

/** One ticket's timeline with durations, its review pass rate and its precision; null when it is not in the project. */
export async function ticketKpisFor(projectId: string, ticketId: string, now = new Date()) {
  const repo = repository();
  if ((await repo.projectOfCard(ticketId)) !== projectId) return null;
  const [entries, changes] = await Promise.all([repo.ticketColumnEntries(ticketId), repo.ticketChanges(ticketId)]);
  return {
    id: ticketId,
    entries: timeline(entries, now),
    passRate: passRate(entries),
    precision: precision(changes),
  };
}
