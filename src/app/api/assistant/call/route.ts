import { launch } from "@/lib/agents/pipeline";
import { answer } from "@/lib/assistant/turn";
import { asSignedIn, currentUser } from "@/lib/auth/user";
import { activeProject, noProject } from "@/lib/board/project";
import { repository } from "@/lib/db";
import { guestLabel } from "@/lib/meetings/guests";
import { openerPrompt } from "@/lib/pm/questions";
import { limited, RUN } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** The message that opens a meeting: the PM chairs, each guest speaks in turn, the PM sums up. */
export function meetingOpening(title: string, agenda: string, guests: string[]): string {
  const items = agenda.split("\n").map((l) => l.trim()).filter(Boolean);
  const names = guests.map((g) => guestLabel(g as never));
  return [
    `[From Formic, not the person] The meeting "${title}" has started and you chair it.`,
    items.length ? `Agenda:\n${items.map((l, i) => `${i + 1}. ${l}`).join("\n")}` : "There is no agenda: ask what to cover.",
    `Read the agenda aloud first (the title, how many items, then each item in a line). ${
      names.length ? `Then ${names.join(", ")} each give their part in turn, ` : ""
    }and last you sum up and propose what should change, as proposals the person can approve.`,
  ].join("\n\n");
}

/**
 * A PM call started: the PM opens it, through the same queue as a typed
 * message, with the questions waiting on the person or a greeting. With a
 * meetingId the PM reads that meeting's agenda, each guest gives its part in
 * turn and the PM sums up, all queued as speakers.
 */
export const POST = asSignedIn(async (req: Request) => {
  const refused = limited(req, RUN, "run-start");
  if (refused) return refused;
  if (!(await currentUser())) return Response.json({ error: "Sign in first." }, { status: 401 });
  const project = await activeProject();
  if (!project) return noProject();

  const repo = repository();
  const projectId = project.id;
  const body = (await req.json().catch(() => null)) as { meetingId?: unknown } | null;
  if (typeof body?.meetingId === "string") {
    const meeting = (await repo.meetings(projectId)).find((m) => m.id === body.meetingId);
    if (!meeting) return Response.json({ error: "No such meeting." }, { status: 404 });
    const guests = meeting.guests.filter((g) => g !== "assistant" && g !== "pm");
    const busy = (await repo.assistantMessages(projectId)).some((m) => m.status === "pending");
    await repo.addAssistantMessage({ projectId, role: "user", content: meetingOpening(meeting.title, meeting.agenda, guests) });
    const speakers = ["assistant", ...guests, "assistant"];
    const replies = [];
    for (const speaker of speakers) {
      replies.push(await repo.addAssistantMessage({ projectId, role: "assistant", content: "", status: "pending", speaker }));
    }
    const first = replies[0]!;
    if (!busy) launch(() => answer(projectId, first.id), `assistant meeting ${first.id}`);
    return Response.json({ id: first.id });
  }
  // The queue starts a later reply without a prompt, so an opener only goes
  // in when the PM is free; a call that starts mid-answer simply listens.
  if ((await repo.assistantMessages(projectId)).some((m) => m.status === "pending")) return Response.json({ id: null });
  const waiting = (await repo.boardCards(projectId)).filter((c) => c.blockedReason);
  const pending = await repo.addAssistantMessage({ projectId, role: "assistant", content: "", status: "pending" });
  launch(() => answer(projectId, pending.id, openerPrompt(waiting)), `assistant opener ${pending.id}`);
  return Response.json({ id: pending.id });
});
