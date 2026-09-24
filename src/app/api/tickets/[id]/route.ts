import { NextRequest } from "next/server";
import { repository } from "@/lib/db";
import { activeProject } from "@/lib/board/project";
import type { FormicEvent } from "@/lib/domain/events";
import {
  ACTIVITY_EVENTS,
  activityOf,
  appendActivity,
  type TicketActivity,
  type TicketView,
} from "@/lib/domain/ticket-view";

export const dynamic = "force-dynamic";

const notFound = () => Response.json({ error: "Not found" }, { status: 404 });

/** A ticket's own view: the ticket, its plan, and what its agents did. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const repo = repository();
  const project = await activeProject();
  if (!project || (await repo.projectOfCard(id)) !== project.id) return notFound();

  const detail = await repo.ticketDetail(id);
  const cards = await repo.boardCards(project.id);
  const card = cards.find((c) => c.id === id);
  if (!detail || !card) return notFound();

  const epic = cards.find((c) => c.id === detail.epicId);
  const events = await repo.ticketEvents(project.id, id, [...ACTIVITY_EVENTS], 300);
  let activity: TicketActivity[] = [];
  for (const e of events) {
    // The payload is the event as it was published.
    const item = activityOf(e.payload as FormicEvent, id, e.seq, e.at.toISOString());
    if (item) activity = appendActivity(activity, item);
  }

  const view: TicketView = {
    card,
    epic: epic ? { id: epic.id, key: epic.key, title: epic.title } : null,
    description: detail.description,
    acceptanceCriteria: detail.acceptanceCriteria,
    branchName: detail.branchName,
    summary: detail.summary,
    dependsOn: card.dependsOn.flatMap((depId) => {
      const dep = cards.find((c) => c.id === depId);
      return dep ? [{ id: dep.id, key: dep.key, title: dep.title, status: dep.status }] : [];
    }),
    plan: detail.plan,
    handoff: detail.handoff,
    activity,
    canStop: card.status === "running" || !!detail.runnerJob || !!card.workingSince,
  };
  return Response.json(view);
}
