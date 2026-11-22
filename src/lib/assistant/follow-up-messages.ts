import "server-only";

import type { FollowUp } from "@/lib/agents/follow-ups";
import { credentialsForProject } from "@/lib/auth/credentials";
import { projectFor } from "@/lib/board/project";
import { repository } from "@/lib/db";
import { vcs } from "@/lib/vcs";
import { postPmMessage } from "./pm-messages";

/** Names of the completed checks on the pull request that failed or timed out; none when GitHub can't be read. */
async function failingChecks(projectId: string, prNumber: number | null): Promise<string[]> {
  if (!prNumber) return [];
  try {
    const project = await projectFor(projectId);
    const creds = await credentialsForProject(project);
    const client = vcs(project.repoFullName, creds.repoToken);
    const pull = await client.pullRequest(prNumber);
    const checks = await client.checksFor(pull.headSha);
    return checks
      .filter((c) => c.status === "completed" && (c.conclusion === "failure" || c.conclusion === "timed_out"))
      .map((c) => c.name);
  } catch {
    return [];
  }
}

/**
 * Tells the person in the board chat what a merged ticket's agents
 * proposed: each nice-to-have as an Add ticket / Dismiss proposal, and the
 * needed tickets already added as links. Only what was not reported before.
 * Runs at approval and at merge. A ticket is done when its change is on the
 * base branch; before that the message says approved and in review, and names
 * the checks that are failing.
 */
export async function proposeFollowUps(projectId: string, ticketId: string): Promise<void> {
  const repo = repository();
  const ticket = await repo.ticketDetail(ticketId);
  if (!ticket) return;

  const nice = ticket.followUps.filter((f) => f.outcome?.kind === "pending");
  const needed = ticket.followUps.filter((f) => f.outcome?.kind === "added" && !f.outcome.announced);
  if (nice.length === 0 && needed.length === 0) return;

  const points = (f: FollowUp) => (f.points ? ` (${f.points} pt)` : "");
  let head = `${ticket.key} · ${ticket.title} is done.`;
  if (ticket.status !== "merged") {
    const failing = await failingChecks(projectId, ticket.prNumber);
    head = `${ticket.key} · ${ticket.title} is approved and in review${
      failing.length ? `; ${failing.join(", ")} ${failing.length === 1 ? "is" : "are"} failing` : ""
    }.`;
  }
  const lines = [head];
  if (needed.length > 0) {
    lines.push("", "Added to To Do, still needed:");
    for (const f of needed) {
      const key = f.outcome?.kind === "added" ? f.outcome.key : "";
      lines.push(`- ${key}: ${f.title}`);
    }
  }
  if (nice.length > 0) {
    lines.push("", "Nice to have, if you want them:");
    for (const f of nice) lines.push(`- ${f.title}${points(f)}${f.why ? `: ${f.why}` : ""}`);
  }

  const cards = needed.flatMap((f) =>
    f.outcome?.kind === "added" ? [{ id: f.outcome.cardId, key: f.outcome.key, title: f.title }] : [],
  );
  const posted = await postPmMessage(projectId, {
    content: lines.join("\n"),
    cards,
    proposals: nice.map((f) => ({
      summary: `Add ticket: ${f.title}${points(f)}`,
      action: { type: "add_follow_up", ticket: ticket.key, title: f.title },
      state: "proposed" as const,
    })),
  });

  // Re-read so a follow-up recorded meanwhile is not overwritten.
  const latest = (await repo.ticketDetail(ticketId))?.followUps ?? ticket.followUps;
  const followUps = latest.map((f): FollowUp => {
    if (f.outcome?.kind === "pending" && nice.some((n) => n.title === f.title)) {
      return { ...f, outcome: { kind: "proposed", messageId: posted.id } };
    }
    if (f.outcome?.kind === "added" && !f.outcome.announced && needed.some((n) => n.title === f.title)) {
      return { ...f, outcome: { ...f.outcome, announced: true } };
    }
    return f;
  });
  await repo.updateTicket(ticketId, { followUps });
}
