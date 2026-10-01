import { NextRequest } from "next/server";
import { z } from "zod";
import { WORK_TYPES } from "@/lib/domain/entities";
import { columnFor } from "@/lib/domain/status";
import { budgetFor, minutesSetting } from "@/lib/budget/budget-for";
import { getRunTimeBudgetSettings } from "@/lib/user-settings";
import { limited, RUN } from "@/lib/rate-limit";
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

  // The same rule a run is held to: the column's override, else the person's setting.
  // `requested` rather than `value`, so mode Off reads as no budget, not the path's rail.
  const column = columnFor(card.status, card.stalledIn);
  const time = project.ownerId ? await getRunTimeBudgetSettings(project.ownerId) : null;
  const budget = budgetFor(
    time ? { minutes: minutesSetting(time) } : null,
    (await repo.columnOverrides(project.id))[column],
    card,
    "loop",
  );
  const usedMs = await repo.ticketRunMs(id);

  const view: TicketView = {
    card,
    epic: epic ? { id: epic.id, key: epic.key, title: epic.title } : null,
    description: detail.description,
    acceptanceCriteria: detail.acceptanceCriteria,
    branchName: detail.branchName,
    dependsOn: card.dependsOn.flatMap((depId) => {
      const dep = cards.find((c) => c.id === depId);
      return dep ? [{ id: dep.id, key: dep.key, title: dep.title, status: dep.status }] : [];
    }),
    plan: detail.plan,
    handoff: detail.handoff,
    activity,
    usage: { usedMinutes: Math.round(usedMs / 60_000), budgetMinutes: budget.minutes.requested },
    canStop: card.status === "running" || !!detail.runnerJob || !!card.workingSince,
  };
  return Response.json(view);
}

const patchSchema = z.object({ workType: z.enum(WORK_TYPES).nullable() });

/** Marks a ticket in To Do as a bug or a spike, or clears it. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const refused = limited(req, RUN, "ticket-work-type");
  if (refused) return refused;

  const { id } = await params;
  const repo = repository();
  const project = await activeProject();
  if (!project || (await repo.projectOfCard(id)) !== project.id) return notFound();

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid work type." },
      { status: 400 },
    );
  }

  const card = (await repo.boardCards(project.id)).find((c) => c.id === id);
  if (!card) return notFound();
  if (columnFor(card.status, card.stalledIn) !== "todo") {
    return Response.json(
      { error: "The work type can only change while the ticket is in To Do." },
      { status: 409 },
    );
  }

  await repo.updateTicket(id, { workType: parsed.data.workType });
  return Response.json({ ok: true });
}
