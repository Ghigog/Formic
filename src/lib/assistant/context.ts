import "server-only";

import { truncate } from "@/lib/agents/coding-loop";
import { repository } from "@/lib/db";
import type { BoardCard } from "@/lib/domain/entities";
import { COLUMN_LABELS, columnFor } from "@/lib/domain/status";
import { parseRunTitle, RUNNER_WORKFLOW_FILE } from "@/lib/runner/workflow";
import type { VcsClient } from "@/lib/vcs";

/**
 * What the board's assistant knows of the board without asking: every card
 * that is still in play, with why it is where it is, and on request the
 * live state of one card on GitHub.
 *
 * The snapshot used to be the whole board cut to its first and last 6,000
 * characters, so on a busy board the cards in the middle (In Progress and In
 * Review, the ones people ask about) were the ones dropped. Finished work
 * now takes a line per Epic, and what is left fits.
 */

const SNAPSHOT_BUDGET = 24_000;
const REASON_CHARS = 240;
const RECENT_RUNS = 8;
const CHECK_LOG_CHARS = 4_000;

function where(c: BoardCard): string {
  return `${COLUMN_LABELS[columnFor(c.status, c.stalledIn)]} · ${c.status}`;
}

function minutesSince(iso: string, now: number): number {
  return Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
}

function oneLine(text: string, limit = REASON_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** Why a card is where it is, in a few words, or "" when nothing is unusual. */
function stateNote(c: BoardCard, now: number): string {
  const notes: string[] = [];
  if (c.workingSince) notes.push(`agent working for ${minutesSince(c.workingSince, now)} min`);
  if (c.blockedReason) notes.push(`reason: ${oneLine(c.blockedReason)}`);
  if (c.misplacedReason) notes.push(`misplaced: ${oneLine(c.misplacedReason)}`);
  if (c.needsHuman && c.status !== "merged") notes.push(`for a person: ${oneLine(c.needsHuman, 120)}`);
  return notes.length ? ` — ${notes.join("; ")}` : "";
}

export function boardSnapshot(cards: BoardCard[], now = Date.now()): string {
  const live = cards.filter((c) => !c.archived);
  if (live.length === 0) return "(The board is empty.)";
  const byId = new Map(live.map((c) => [c.id, c]));
  const ticketLine = (c: BoardCard) => {
    const deps = c.dependsOn.map((id) => byId.get(id)?.key).filter(Boolean);
    return `  - ${c.key} [${where(c)}] ${c.title} (scope: ${c.fileScope.join(", ") || "none"}${
      deps.length ? `; after ${deps.join(", ")}` : ""
    }${c.prNumber ? `; PR #${c.prNumber}` : ""})${stateNote(c, now)}`;
  };
  const ticketsOf = (epicId: string) => live.filter((c) => c.kind === "ticket" && c.epicId === epicId);

  const lines: string[] = [];
  const epics = live.filter((c) => c.kind === "epic");
  for (const epic of epics.filter((e) => e.status !== "merged")) {
    lines.push(`- Epic ${epic.key} [${where(epic)}] ${epic.title}${stateNote(epic, now)}`);
    const tickets = ticketsOf(epic.id);
    for (const t of tickets.filter((t) => t.status !== "merged")) lines.push(ticketLine(t));
    const merged = tickets.filter((t) => t.status === "merged");
    if (merged.length) lines.push(`  - merged: ${merged.map((t) => t.key).join(", ")}`);
  }
  const orphans = live.filter((c) => c.kind === "ticket" && !byId.has(c.epicId ?? ""));
  const openOrphans = orphans.filter((t) => t.status !== "merged");
  if (openOrphans.length) lines.push("- Tickets without an Epic", ...openOrphans.map(ticketLine));
  const done = epics.filter((e) => e.status === "merged");
  if (done.length) {
    lines.push(`- Finished Epics: ${done.map((e) => `${e.key} ${e.title} (${ticketsOf(e.id).length} tickets)`).join("; ")}`);
  }
  return truncate(lines.join("\n"), SNAPSHOT_BUDGET);
}

/**
 * The card keys a message names, however it writes them: "T-94", "t94" and
 * "t 94" are all T-94. Longest keys first, so EPIC-12-T3 is not also EPIC-12.
 */
export function mentionedKeys(text: string, cards: Pick<BoardCard, "key">[]): string[] {
  const found: string[] = [];
  let rest = text;
  for (const key of cards.map((c) => c.key).sort((a, b) => b.length - a.length)) {
    const pattern = key
      .split(/[-\s]+|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/)
      .filter(Boolean)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[\\s-]?");
    const re = new RegExp(`(?<![A-Za-z0-9])${pattern}(?![A-Za-z0-9])`, "gi");
    if (re.test(rest)) {
      found.push(key);
      rest = rest.replace(re, " ");
    }
  }
  return found;
}

/**
 * One card as it is right now, on the board and on GitHub: where it is and
 * why, whether an agent is on it, its pull request and checks, the log of a
 * red one, and the agent runs it has had. Enough to tell stuck from busy.
 */
export async function cardReport(projectId: string, key: string, client: VcsClient, now = Date.now()): Promise<string> {
  const repo = repository();
  const cards = await repo.boardCards(projectId);
  const card = cards.find((c) => c.key.toLowerCase() === key.trim().toLowerCase());
  if (!card) return `${key} is not on the board.`;

  const lines = [`${card.key} (${card.kind}) ${card.title}`, `Where: ${where(card)}${card.archived ? " (archived)" : ""}`];
  if (card.updatedAt) lines.push(`Last changed: ${minutesSince(card.updatedAt, now)} min ago`);
  if (card.workingSince) lines.push(`An agent has been working on it for ${minutesSince(card.workingSince, now)} min.`);
  if (card.blockedReason) lines.push(`Reason shown on the card: ${card.blockedReason}`);
  if (card.misplacedReason) lines.push(`Misplaced: ${card.misplacedReason}`);
  if (card.needsHuman) lines.push(`Work for a person: ${card.needsHuman}`);

  if (card.kind === "epic") {
    const tickets = cards.filter((c) => c.kind === "ticket" && c.epicId === card.id);
    lines.push("Tickets:", ...tickets.map((t) => `- ${t.key} [${where(t)}] ${t.title}${stateNote(t, now)}`));
    return lines.join("\n");
  }

  const ticket = await repo.ticketDetail(card.id);
  if (ticket) {
    lines.push(`Attempts: ${ticket.attempts}`);
    if (ticket.runnerJob) lines.push(`Waiting on GitHub Actions job ${ticket.runnerJob}.`);
    if (ticket.branchName) lines.push(`Branch: ${ticket.branchName}`);
    if (ticket.plan.length) {
      lines.push("Plan:", ...ticket.plan.map((s) => `- [${s.status === "done" ? "x" : s.status === "in_progress" ? "~" : " "}] ${s.step}`));
    }
    if (ticket.summary) lines.push(`Last report from its agent: ${oneLine(ticket.summary, 1_200)}`);
  }

  const runs = await client.recentRuns(RUNNER_WORKFLOW_FILE).catch(() => []);
  const own = runs
    .map((r) => ({ ...r, parsed: parseRunTitle(r.title) }))
    .filter((r) => r.parsed?.ticketKey === card.key)
    .slice(0, RECENT_RUNS);
  if (own.length) {
    lines.push(
      "Its agent runs on GitHub Actions, newest first:",
      ...own.map((r) => `- ${r.parsed!.mode}: ${r.conclusion ?? r.status} ${r.url}`),
    );
  }

  if (card.prNumber) {
    try {
      const pull = await client.pullRequest(card.prNumber);
      lines.push(
        `Pull request #${pull.number} ${pull.url}: ${pull.merged ? "merged" : pull.state}, ${
          pull.mergeable === false ? "conflicts with its base" : pull.mergeable ? "mergeable" : "mergeability unknown"
        }, head ${pull.headSha.slice(0, 7)} on ${pull.headBranch}`,
      );
      const checks = await client.checksFor(pull.headSha);
      if (checks.length === 0) lines.push("No checks on its head.");
      for (const c of checks) lines.push(`- check ${c.name}: ${c.status === "completed" ? c.conclusion : c.status}`);
      const red = checks.find((c) => c.status === "completed" && (c.conclusion === "failure" || c.conclusion === "timed_out"));
      if (red) {
        const log = await client.checkLog(red.id).catch(() => null);
        if (log) {
          const notes = log.annotations.slice(0, 5).map((a) => `${a.path}${a.line ? `:${a.line}` : ""} ${a.message}`);
          lines.push(`Why ${red.name} failed:`, truncate([log.summary, ...notes].filter(Boolean).join("\n"), CHECK_LOG_CHARS));
        }
      }
    } catch (e) {
      lines.push(`Could not read its pull request: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return lines.join("\n");
}
