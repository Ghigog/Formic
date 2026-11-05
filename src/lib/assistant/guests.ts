import "server-only";

import { z } from "zod";

import { applyCardAction, cardActionSchema, CARD_ACTIONS_GUIDE } from "@/lib/agents/card-actions";
import type { ToolDef } from "@/lib/agents/chat-loop";
import { assistantAgentFor, columnChatAgentFor } from "@/lib/agents/presets";
import { repository } from "@/lib/db";
import type { AssistantProposal } from "@/lib/db/repository";
import { AGENT_ROLE_LABELS, COLUMN_AGENT_ROLE, type AgentRole } from "@/lib/domain/entities";
import { COLUMN_LABELS, COLUMNS, columnOf, type ColumnId } from "@/lib/domain/status";
import { COLUMN_AGENT_GUESTS } from "@/lib/meetings/guests";
import { sentinel as findSentinel } from "@/lib/sentinels/roster";
import { sentinelsFor } from "@/lib/sentinels/service";

/**
 * The agents besides the PM that answer in the general chat: a column's agent
 * with the card actions on its own column's cards, and a Sentinel talking from
 * its latest audit, acting on nothing.
 */

const SENTINEL_PREFIX = "sentinel:";

/** The column an agent speaker works: the inverse of COLUMN_AGENT_ROLE. */
export function columnOfSpeaker(speaker: string): ColumnId | null {
  if (!(COLUMN_AGENT_GUESTS as readonly string[]).includes(speaker)) return null;
  const found = Object.entries(COLUMN_AGENT_ROLE).find(([, role]) => role === speaker);
  return found ? (found[0] as ColumnId) : null;
}

/** The Sentinel a speaker is, if it is one. */
export function sentinelOfSpeaker(speaker: string): string | null {
  return speaker.startsWith(SENTINEL_PREFIX) ? speaker.slice(SENTINEL_PREFIX.length) : null;
}

export const actOnCardInput = z.object({ key: z.string().min(1), action: z.unknown() });

export const ACT_ON_CARD_DEF: ToolDef = {
  name: "act_on_card",
  description:
    "Do something to one card in your column, by its key: move, close, redo, stop, edit_ticket or needs_human. It happens at once, and the result says what happened, except a move to Done: that waits for the person's approval. Cards in other columns are not yours to act on.",
  schema: {
    type: "object",
    properties: {
      key: { type: "string", description: "The card's key, e.g. \"T-94\"." },
      action: z.toJSONSchema(cardActionSchema),
    },
    required: ["key", "action"],
    additionalProperties: false,
  },
};

/**
 * Carries out an action on a card of this column, as its card chat would, and
 * says what happened. A move to Done is not carried out: it becomes a
 * move_card proposal in `proposals`, because a merge waits for the person.
 */
export async function actOnColumnCard(
  projectId: string,
  column: ColumnId,
  key: string,
  raw: unknown,
  proposals: AssistantProposal[],
): Promise<string> {
  const card = (await repository().boardCards(projectId)).find((c) => c.key.toLowerCase() === key.trim().toLowerCase());
  if (!card) return `There is no card ${key}.`;
  const where = columnOf(card);
  if (where !== column) {
    return `${card.key} is in ${COLUMN_LABELS[where]}, not ${COLUMN_LABELS[column]}: it is not mine to act on.`;
  }
  const action = cardActionSchema.safeParse(raw);
  if (!action.success) {
    return `Not done: ${action.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ")}`;
  }
  if (action.data.type === "move" && action.data.to === "done") {
    proposals.push({
      summary: `Move ${card.key} to ${COLUMN_LABELS.done}`,
      action: { type: "move_card", key: card.key, to: "done" },
      state: "proposed",
    });
    return `Proposed moving ${card.key} to ${COLUMN_LABELS.done}. It happens only if the person approves it.`;
  }
  return applyCardAction(projectId, card.kind, card.id, action.data);
}

/** A column agent's instructions, with the cards it can act on. */
export async function columnSystemPrompt(
  projectId: string,
  column: ColumnId,
  role: AgentRole,
  repoFullName: string,
  brief: string | null,
): Promise<string> {
  const cards = (await repository().boardCards(projectId)).filter((c) => columnOf(c) === column);
  return [
    `You are the ${AGENT_ROLE_LABELS[role]} Agent: the agent the person set for the ${COLUMN_LABELS[column]} column of a Formic board for the GitHub repository ${repoFullName}. You are answering in the board's general chat. The cards in ${COLUMN_LABELS[column]} are yours; you act on no others.`,
    ...(brief ? ["", "Your instructions for this column's work:", brief.trim()] : []),
    "",
    "Read the repository before you answer a question about its code. Do not guess at what a file contains.",
    "",
    CARD_ACTIONS_GUIDE.replace("this column's work on the card", "this column's work on the card named"),
    "Name the card you act on by its key in act_on_card. A move to Done is only a proposal: the person approves it.",
    "Before you say why any card is where it is, look at it with card_status: it shows the card's pull request, checks and agent runs from GitHub. You may look at any card, not only yours.",
    "",
    `The cards in ${COLUMN_LABELS[column]} now:`,
    ...(cards.length
      ? cards.map((c) => `- ${c.key} [${c.status}] ${c.title}${c.blockedReason ? ` (${c.blockedReason})` : ""}`)
      : ["(none)"]),
  ].join("\n");
}

/** A Sentinel's persona and its latest audit: what it talks from, with no tools. */
export async function sentinelSystemPrompt(projectId: string, sentinelId: string): Promise<string | null> {
  const s = findSentinel(sentinelId);
  const state = (await sentinelsFor(projectId))[sentinelId];
  if (!s || !state?.report) return null;
  const points = (label: string, list: Array<{ text: string; ref: string | null }>) =>
    list.length ? [`${label}:`, ...list.map((p) => `- ${p.text}${p.ref ? ` (${p.ref})` : ""}`)] : [];
  return [
    s.persona,
    "",
    `You are answering in the board's general chat. Answer only from your latest audit of this board, below. You cannot audit again from here: when something is not in it, say so and that a new audit would tell.${state.auditStale ? " Work has shipped since this audit, so say that it may be out of date." : ""}`,
    "",
    `Your latest audit${state.at ? ` (${state.at})` : ""}: ${state.stars ?? "?"} stars.`,
    ...(state.quote ? [`In your words: ${state.quote}`] : []),
    ...(state.summary ? [state.summary] : []),
    ...points("What you like", state.report.likes),
    ...points("What you dislike", state.report.dislikes),
    ...points("What is wrong", state.report.wrong),
    ...points("What is missing", state.report.missing),
  ].join("\n");
}

/** An API agent on the board to speak through when a guest's own agent is a CLI one, which answers in minutes. */
export async function quickVoice(projectId: string) {
  const pm = await assistantAgentFor(projectId);
  if (pm.kind === "api" && (pm.apiKey || pm.info.kind === "anthropic")) return pm;
  for (const column of COLUMNS) {
    const agent = await columnChatAgentFor(projectId, column).catch(() => null);
    if (agent?.kind === "api" && (agent.apiKey || agent.info.kind === "anthropic")) return agent;
  }
  return null;
}
