import "server-only";

import { withCardActor } from "@/lib/auth/actor";
import { repository } from "@/lib/db";
import type { TicketDetail } from "@/lib/db/repository";
import { publish } from "@/lib/events/bus";
import { launch, startRun } from "@/lib/agents/pipeline";
import { agentFor, runTargetFor, withColumnPreset } from "@/lib/agents/presets";
import { MAX_DIFF_CHARS, type ScoutCandidate } from "@/lib/agents/judge";
import type { CodeChange, Usage } from "@/lib/agents/ports";
import { credentialsForProject } from "@/lib/auth/credentials";
import { projectFor } from "@/lib/board/project";
import { withLease } from "@/lib/board/lease";
import { slotsInUse } from "@/lib/colony/reserve";
import { AUTO_SCOUTED, blockerOf, colonyOf } from "@/lib/board/queue";
import { byPosition } from "@/lib/ordering";
import { columnFor } from "@/lib/domain/status";
import { mergeTarget, vcs, type VcsClient } from "@/lib/vcs";
import { addNote, noteTexts } from "./notes";
import { shareNote } from "./shared-notes";

/** The Coder Agent's stage, as src/lib/coder/pipeline.ts numbers it. */
const STAGE_CODE_RUN = 5;

/**
 * Scouts: several attempts at one ticket at once, each told to take a
 * different approach, of which the Reviewer Agent keeps one.
 *
 * Ant colonies send scouts out before they commit: most come back with
 * nothing, and the colony follows the one that found the best route. Here a
 * person sends 2 to 4 scouts on a ticket in To Do (how many, by level: see
 * src/lib/colony/reserve.ts). Each is a copy of the ticket, off the board, run
 * through the Coder Agent's pipeline like any ticket, on a branch of its own
 * and, if the person chose, on an agent template of its own. A scout's work
 * stops at its branch: it opens no pull request.
 *
 * When every scout is back, those that pushed a change within the ticket's
 * files go to the Reviewer Agent, which picks one and says why. That one
 * becomes the ticket's pull request and goes through review, CI and merging
 * as any other. What the others found is shared with the repository's agents
 * as notes. Until it merges, the person can swap the pick from the drawer.
 *
 * The parent ticket holds the file reservation for all of them and counts one
 * colony slot per scout while they are out.
 */

/** The approaches scouts are told to take, one each, in order. */
export const SCOUT_APPROACHES = [
  "Make the smallest change that meets every acceptance criterion. Touch as few lines and files as you can.",
  "Make the most robust change: handle the edge cases and failure paths the ticket implies, and add or extend tests that prove them.",
  "Make the cleanest change: the design a maintainer of this code would want, simplifying nearby code where that makes the change clearer.",
  "Take a different route from the obvious one: question how the code does this today and prefer an approach that removes complexity.",
] as const;

/** The short name of each approach, for the card and the chat. */
export const SCOUT_APPROACH_NAMES = ["smallest", "most robust", "cleanest", "different route"] as const;

export function approachName(brief: string | null): string {
  const i = SCOUT_APPROACHES.findIndex((a) => a === brief);
  return i >= 0 ? SCOUT_APPROACH_NAMES[i]! : "own approach";
}

function label(scout: TicketDetail): string {
  return `S${scout.key.match(/-s(\d+)$/)?.[1] ?? "?"}`;
}

/** A scout's place in the ticket it scouts for, for its brief. */
function scoutBrief(scout: TicketDetail, of: number): string {
  return `You are ${label(scout)}, one of ${of} scouts trying this ticket at once, each told to take a different approach. Your approach: ${scout.scoutBrief ?? "your own"} Do it well on its own terms; the Reviewer Agent compares the changes and keeps the best.`;
}

/**
 * The notes a ticket's run is briefed with. A scout's are its parent's, with
 * its approach as the newest, so it wins where they disagree.
 */
export async function ticketNoteTexts(projectId: string, ticket: TicketDetail): Promise<string[]> {
  if (!ticket.scoutOf) return noteTexts(projectId, ticket.id);
  const siblings = await repository().scoutsOf(ticket.scoutOf);
  return [...(await noteTexts(projectId, ticket.scoutOf)), scoutBrief(ticket, siblings.length)];
}

/** Whether a ticket's run sends scouts out instead of coding itself. */
export function scouting(ticket: TicketDetail): boolean {
  return !ticket.scoutOf && ticket.scouts > 0 && !ticket.scoutPick && !ticket.prNumber;
}

export type ScoutAnswer = { ok: true } | { ok: false; reason: string };

/**
 * A person sends one scout on a ticket in In Progress: a second attempt, on
 * the scout agent the board sets (the column's agent when it sets none). A
 * ticket whose attempt failed starts again to send it, or waits its turn.
 */
export async function sendScouts(
  projectId: string,
  ticketId: string,
  input: { auto?: boolean } = {},
): Promise<ScoutAnswer> {
  const repo = repository();
  const ticket = await repo.ticketDetail(ticketId);
  if (!ticket || ticket.projectId !== projectId || ticket.scoutOf) return { ok: false, reason: "That ticket is not on this board." };
  if (columnFor(ticket.status, ticket.stalledIn) !== "in_progress" || ticket.prNumber) {
    return { ok: false, reason: "A scout goes out on a ticket in In Progress." };
  }
  if (ticket.needsHuman) return { ok: false, reason: "This ticket is work for a person." };

  const before = await repo.scoutsOf(ticketId);
  if (before.some((s) => s.status === "running" || s.status === "ready")) {
    return { ok: false, reason: "A scout is already out on this ticket." };
  }

  const cards = await repo.boardCards(projectId);
  const card = cards.find((c) => c.id === ticketId);
  if (!card) return { ok: false, reason: "That ticket is not on this board." };
  // A scout starts from the merge target: it cannot stack on an open pull request.
  const open = card.dependsOn.map((id) => cards.find((c) => c.id === id)).filter((c) => c && c.status !== "merged");
  if (open.length > 0) return { ok: false, reason: "Scouts go out once everything the ticket depends on has merged." };

  const project = await repo.projectById(projectId);
  // A ticket already running holds one slot: its scout needs another.
  const running = ticket.status === "running";
  if (running && !input.auto && project && project.colonySize !== null) {
    const size = colonyOf(project, cards).colonySize ?? project.colonySize;
    if (slotsInUse(cards) + 1 > size) return { ok: false, reason: `The colony is full: ${slotsInUse(cards)} of ${size} slots in use.` };
  }

  // A scout sent before and never picked from is replaced.
  if (before.length) await repo.deleteTickets(before.map((s) => s.id));
  await repo.createScouts(ticketId, [{ brief: SCOUT_APPROACHES[3], presetId: project?.scoutPresetId ?? null }]);
  await repo.updateTicket(ticketId, { scouts: 1, scoutPick: null, scoutWhy: input.auto ? AUTO_SCOUTED : null });

  // Already running its own attempt: the scout goes out beside it. Queued,
  // it goes out when the ticket starts.
  if (running) {
    const [scout] = await repo.scoutsOf(ticketId);
    await launchScout(projectId, scout!);
    return { ok: true };
  }
  if (ticket.status === "queued") return { ok: true };

  // Stopped in In Progress: it starts again to send its scout. The reserve's
  // own scouts take its idle slots, with no colony check.
  const { claimOrQueue } = await import("@/lib/board/queue");
  const write = (status: "running" | "queued") =>
    repo.updateTicket(ticketId, { status, stalledIn: null, blockedReason: null, attempts: 0 });
  const { status, reason } = await claimOrQueue(projectId, { ...card, scouts: 1 }, write, { reserve: !!input.auto });
  await publish(projectId, {
    type: "card.status",
    cardId: ticketId,
    kind: "ticket",
    status,
    stalledIn: null,
    stage: STAGE_CODE_RUN,
    blockedReason: reason,
  });
  if (status === "running") {
    const { runCoderAgent } = await import("./pipeline");
    launch(() => runCoderAgent(projectId, ticketId), `scout for ${ticket.key}`);
  }
  return { ok: true };
}

/** Starts a scout's run on the scout agent, or the column's when none is set. */
async function launchScout(projectId: string, scout: TicketDetail): Promise<void> {
  await repository().updateTicket(scout.id, { status: "running", stalledIn: null, blockedReason: null });
  const { runCoderAgent } = await import("./pipeline");
  launch(
    () => withColumnPreset("in_progress", scout.scoutPresetId, () => runCoderAgent(projectId, scout.id)),
    `scout ${scout.key}`,
  );
}

/**
 * The parent started: its scouts go out. Run again on a parent already out
 * (the idle sweep, a lost start), it sends only the scouts with nothing
 * working them.
 */
/** A ticket's scouts, sent on the keys of whoever set the ticket going. */
export async function runScouts(projectId: string, parent: TicketDetail): Promise<void> {
  return withCardActor(parent.id, () => sendOut(projectId, parent));
}

async function sendOut(projectId: string, parent: TicketDetail): Promise<void> {
  const repo = repository();
  const scouts = await repo.scoutsOf(parent.id);
  if (scouts.length === 0) {
    // Nothing to send: the ticket is worked on the ordinary way.
    await repo.updateTicket(parent.id, { scouts: 0 });
    const { runCoderAgent } = await import("./pipeline");
    await runCoderAgent(projectId, parent.id);
    return;
  }

  await repo.updateTicket(parent.id, { stage: STAGE_CODE_RUN, blockedReason: null });
  const live = new Set(
    (await repo.unfinishedRuns(new Date())).map((r) => r.ticketId).filter((id): id is string => !!id),
  );
  for (const scout of scouts) {
    const lost = scout.status === "running" && !scout.runnerJob && !live.has(scout.id);
    if (scout.status !== "ready" && !lost) continue;
    await launchScout(projectId, scout);
  }
  await publish(projectId, {
    type: "run.progress",
    runId: `scouts:${parent.id}`,
    ticketId: parent.id,
    role: "coder",
    label: "Scout out",
    fraction: 0,
  });
}

/** How a scout's run ended. */
export type ScoutOutcome =
  | { ok: true; branch: string; change: CodeChange; usage?: Usage }
  | { ok: false; reason: string };

/**
 * A scout's run is over, one way or another. Every path a run ends on (a
 * pushed change, a failure, a change outside its files, nothing to do) comes
 * here instead of moving a card. The last one back settles the ticket.
 */
/** A scout's result, taken on the keys of whoever sent it. */
export async function scoutReturned(projectId: string, scout: TicketDetail, outcome: ScoutOutcome): Promise<void> {
  return withCardActor(scout.id, () => takeScoutResult(projectId, scout, outcome));
}

async function takeScoutResult(projectId: string, scout: TicketDetail, outcome: ScoutOutcome): Promise<void> {
  const repo = repository();
  // Replaced by scouts sent since: nothing is waiting for it.
  if (!(await repo.ticketDetail(scout.id))) return;
  if (outcome.ok) {
    await repo.updateTicket(scout.id, {
      status: "review",
      branchName: outcome.branch,
      summary: outcome.change.summary,
      blockedReason: null,
      ...(outcome.usage
        ? { costCents: outcome.usage.costCents, tokensIn: outcome.usage.tokensIn, tokensOut: outcome.usage.tokensOut }
        : {}),
    });
  } else {
    await repo.updateTicket(scout.id, { status: "failed", blockedReason: outcome.reason });
  }
  if (scout.scoutOf) await settle(projectId, scout.scoutOf);
}

/** Once every scout is back, the Reviewer Agent picks among them. Settled once. */
async function settle(projectId: string, parentId: string): Promise<void> {
  const repo = repository();
  const claimed = await withLease(`scouts:${parentId}`, async () => {
    const parent = await repo.ticketDetail(parentId);
    if (!parent || !scouting(parent) || parent.status !== "running") return null;
    const scouts = await repo.scoutsOf(parentId);
    if (scouts.some((s) => s.status === "running" || s.status === "ready")) return null;
    // Marked under the lease, so the last two back cannot both judge.
    await repo.updateTicket(parentId, { scoutPick: "judging" });
    return { parent, scouts };
  }).catch(() => null);
  if (!claimed) return;
  await judge(projectId, claimed.parent, claimed.scouts);
}

async function judge(projectId: string, parent: TicketDetail, scouts: TicketDetail[]): Promise<void> {
  const repo = repository();
  const back = scouts.filter((s) => s.status === "review" && s.branchName);
  const lost = scouts.filter((s) => !back.includes(s));

  if (back.length === 0) {
    const reasons = lost.map((s) => `${label(s)} (${approachName(s.scoutBrief)}): ${s.blockedReason ?? "no change"}`);
    await addNote(projectId, parent.id, `Every scout came back without a change. ${reasons.join(" ")}`.slice(0, 2_000));
    await repo.deleteTickets(scouts.map((s) => s.id));
    // Worked again, it is worked the ordinary way, with what the scouts found as a note.
    await repo.updateTicket(parent.id, { scouts: 0, scoutPick: null });
    const { stallTicket } = await import("./pipeline");
    await stallTicket(projectId, parent, `Every scout came back without a change. ${reasons.join(" ")}`.slice(0, 1_000), {
      blocked: false,
      stalledIn: "in_progress",
      stage: STAGE_CODE_RUN,
    });
    return;
  }

  const project = await projectFor(projectId);
  const creds = await credentialsForProject(project);
  const client = vcs(project.repoFullName, creds.githubToken);

  if (back.length === 1) {
    await adopt(projectId, parent, back[0]!, `${label(back[0]!)} was the only scout that came back with a change.`, [], client);
    return;
  }

  const candidates = await Promise.all(back.map((s) => candidateOf(s, client, mergeTarget(project.baseBranch))));
  const verdict = await compare(projectId, parent, candidates);
  const winner = back.find((s) => label(s) === verdict.pick) ?? back[0]!;
  await adopt(projectId, parent, winner, verdict.why, verdict.lessons, client);
}

async function candidateOf(scout: TicketDetail, client: VcsClient, target: string): Promise<ScoutCandidate> {
  const diff = await client.compare(target, scout.branchName!).catch(() => null);
  const patch = (diff?.patches ?? []).map((p) => `--- ${p.path}\n${p.patch}`).join("\n\n");
  return {
    id: scout.id,
    label: label(scout),
    approach: scout.scoutBrief ?? "its own",
    summary: scout.summary ?? scout.title,
    files: diff?.files ?? [],
    diff: patch.length > MAX_DIFF_CHARS ? `${patch.slice(0, MAX_DIFF_CHARS)}\n… cut short` : patch,
  };
}

/** The Reviewer Agent's pick, or the smallest change when it cannot answer. */
async function compare(
  projectId: string,
  parent: TicketDetail,
  candidates: ScoutCandidate[],
): Promise<{ pick: string; why: string; lessons: string[] }> {
  const smallest = () => {
    const pick = [...candidates].sort((a, b) => a.files.length - b.files.length || a.diff.length - b.diff.length)[0]!;
    return pick.label;
  };
  const reviewer = await agentFor(projectId, "reviewer");
  if (!reviewer.compare) {
    return { pick: smallest(), why: "The Reviewer Agent cannot compare changes here, so the smallest one was kept.", lessons: [] };
  }
  const run = startRun(projectId, "reviewer", {
    ...(await runTargetFor(projectId, "reviewer")),
    epicId: parent.epicId,
    ticketId: parent.id,
  });
  const task = {
    ticketId: parent.id,
    key: parent.key,
    title: parent.title,
    description: parent.description,
    acceptanceCriteria: parent.acceptanceCriteria,
    fileScope: parent.fileScope,
  };
  const outcome = await reviewer.compare(run.ctx, { task, candidates }).catch(
    (e: unknown) =>
      ({
        ok: false,
        blocked: false,
        error: e instanceof Error ? e.message : String(e),
        usage: { model: "none", tokensIn: 0, tokensOut: 0, costCents: 0 },
      }) as const,
  );
  await run.finish(outcome);
  if (!outcome.ok) {
    return { pick: smallest(), why: `The Reviewer Agent could not compare them (${outcome.error}), so the smallest change was kept.`, lessons: [] };
  }
  return outcome.value;
}

/** The picked scout's change becomes the ticket's pull request. */
async function adopt(
  projectId: string,
  parent: TicketDetail,
  winner: TicketDetail,
  why: string,
  lessons: string[],
  client: VcsClient,
): Promise<void> {
  const repo = repository();
  const scouts = await repo.scoutsOf(parent.id);
  await repo.updateTicket(parent.id, { scoutPick: winner.id, scoutWhy: why, branchName: winner.branchName });
  for (const lesson of lessons.slice(0, 3)) await shareNote(projectId, parent.id, lesson);

  const tried = scouts.map((s) => {
    const outcome = s.id === winner.id ? "kept" : s.status === "review" ? "not kept" : `came back empty: ${s.blockedReason ?? "no change"}`;
    return `- ${label(s)} (${approachName(s.scoutBrief)}): ${outcome}`;
  });
  const text = [`Sent ${scouts.length} scouts. Kept ${label(winner)}: ${why}`, "", ...tried, "", "You can swap the pick from the drawer until it merges."].join("\n");
  await repo.addCardChatMessage({ projectId, cardKind: "ticket", cardId: parent.id, role: "assistant", content: text });
  await publish(projectId, { type: "ticket.reply", ticketId: parent.id, agent: "Reviewer Agent", text });

  const { openTicketPullRequest } = await import("./pipeline");
  await openTicketPullRequest(projectId, { ...parent, branchName: winner.branchName }, client, {
    branch: winner.branchName!,
    change: {
      summary: winner.summary ?? parent.title,
      detail: `Kept from ${scouts.length} scouts, each taking its own approach. ${label(winner)} (${approachName(winner.scoutBrief)}): ${why}`,
      verifiedWith: null,
    },
  });
}

/**
 * A person swaps the pick for another scout that came back with a change. The
 * pull request from the old pick is closed and one from the new one opened,
 * which goes through review from the start. Not once it has merged.
 */
export async function swapScout(projectId: string, parentId: string, scoutId: string): Promise<ScoutAnswer> {
  const repo = repository();
  const parent = await repo.ticketDetail(parentId);
  if (!parent || parent.projectId !== projectId) return { ok: false, reason: "That ticket is not on this board." };
  if (!parent.scoutPick || parent.status === "merged") return { ok: false, reason: "There is no pick to swap." };
  if (parent.scoutPick === scoutId) return { ok: true };
  const scout = (await repo.scoutsOf(parentId)).find((s) => s.id === scoutId);
  if (!scout || scout.status !== "review" || !scout.branchName) return { ok: false, reason: "That scout came back without a change." };
  if (parent.status === "running") return { ok: false, reason: "Wait for the Coder Agent working on it to finish." };

  const project = await projectFor(projectId);
  const creds = await credentialsForProject(project);
  const client = vcs(project.repoFullName, creds.githubToken);
  if (parent.branchName) {
    await client.closeSupersededPulls(parent.branchName, scout.branchName, `Swapped for ${label(scout)}, another scout's change.`);
  }
  const why = `${label(scout)} (${approachName(scout.scoutBrief)}), picked by a person.`;
  await repo.updateTicket(parentId, {
    scoutPick: scout.id,
    scoutWhy: why,
    branchName: scout.branchName,
    prNumber: null,
    prUrl: null,
    reviewedSha: null,
    reviewedHead: null,
    stackedOn: null,
  });
  const { openTicketPullRequest } = await import("./pipeline");
  await openTicketPullRequest(projectId, { ...parent, branchName: scout.branchName, prNumber: null }, client, {
    branch: scout.branchName,
    change: {
      summary: scout.summary ?? parent.title,
      detail: `Kept from ${(await repo.scoutsOf(parentId)).length} scouts. ${why}`,
      verifiedWith: null,
    },
  });
  return { ok: true };
}

/**
 * Calls a ticket's scouts back before they are done: the person moved it out
 * of In Progress, or its start was refused. A scout still working stops at
 * its next turn, the way a stopped ticket does.
 */
export async function recallScouts(projectId: string, parentId: string): Promise<void> {
  const repo = repository();
  const scouts = await repo.scoutsOf(parentId);
  // Marked, not deleted: a run still going reads its ticket between turns,
  // and stops on seeing it failed. Rows left behind are off the board and
  // replaced the next time scouts are sent.
  for (const s of scouts) {
    if (s.status === "running" || s.status === "ready") {
      await repo.updateTicket(s.id, { status: "failed", blockedReason: "Recalled." });
    }
  }
  await repo.updateTicket(parentId, { scouts: 0, scoutPick: null, scoutWhy: null });
  void projectId;
}

/** What the drawer shows of a ticket's scouts. */
export interface ScoutView {
  id: string;
  label: string;
  approach: string;
  status: "out" | "back" | "empty";
  summary: string | null;
  reason: string | null;
  picked: boolean;
}

export async function scoutViews(parentId: string): Promise<{ why: string | null; scouts: ScoutView[] }> {
  const repo = repository();
  const parent = await repo.ticketDetail(parentId);
  const scouts = await repo.scoutsOf(parentId);
  return {
    why: parent?.scoutWhy && parent.scoutWhy !== AUTO_SCOUTED ? parent.scoutWhy : null,
    scouts: scouts.map((s) => ({
      id: s.id,
      label: label(s),
      approach: approachName(s.scoutBrief),
      status: s.status === "review" ? "back" : s.status === "running" || s.status === "ready" ? "out" : "empty",
      summary: s.summary,
      reason: s.status === "failed" || s.status === "blocked" ? s.blockedReason : null,
      picked: parent?.scoutPick === s.id,
    })),
  };
}

/**
 * Auto-scouting, once the level unlocks it and the person turns it on: when
 * nothing is waiting and the reserve has slots standing idle, they scout one
 * ticket whose attempt failed. One at a time, one scout each. Urgent work calls them back
 * (src/lib/board/queue.ts). Run from the idle sweep.
 */
export async function autoScout(projectId: string): Promise<void> {
  const repo = repository();
  const project = await repo.projectById(projectId);
  if (!project || project.colonySize === null || !project.autoScout) return;
  const cards = await repo.boardCards(projectId);
  const colony = colonyOf(project, cards);
  if (!colony.autoScout || colony.colonySize === null) return;
  const tickets = cards.filter((c) => c.kind === "ticket");
  if (tickets.some((c) => c.status === "queued")) return;
  if (tickets.some((c) => c.status === "running" && (c.scouts ?? 0) > 0 && !c.scoutPick)) return;
  if (colony.colonySize - slotsInUse(cards) < 1) return;

  const merged = (id: string) => cards.find((c) => c.id === id)?.status === "merged";
  const candidates = tickets
    .filter(
      (c) =>
        !c.needsHuman &&
        !c.prNumber &&
        !c.misplacedIn &&
        c.dependsOn.every(merged) &&
        c.status === "failed" &&
        c.stalledIn === "in_progress",
    )
    .sort(byPosition);
  for (const card of candidates) {
    if (await blockerOf(projectId, card)) continue;
    const sent = await sendScouts(projectId, card.id, { auto: true });
    if (sent.ok) return;
  }
}
