import "server-only";

import { z } from "zod";

import { MODELS } from "@/lib/agents/anthropic";
import { claudeSpeak, openAiSpeak, runChatLoop, type Speak } from "@/lib/agents/chat-loop";
import { originLines, type Origin } from "@/lib/agents/origin";
import { assistantAgentFor } from "@/lib/agents/presets";
import { DESIGN_RULE } from "@/lib/agents/prompts";
import { addNote } from "@/lib/coder/notes";
import { addEpicNote } from "@/lib/agents/epic-notes";
import { repository } from "@/lib/db";
import { agentQuestionSchema, questionReason, type AgentQuestion } from "@/lib/domain/question";
import { extractJson } from "@/lib/llm/openai-compat";
import type { VcsClient } from "@/lib/vcs";

/**
 * The PM, as director. Every other agent checks its work against the step
 * before it; the PM checks it against what the person asked for, at the two
 * moments drift is cheapest to catch: when an Epic's tickets are planned, and
 * when a ticket's change reaches review. On track, it says nothing. Drifting,
 * it steps into the card's chat with a correction the next agent reads, or,
 * when only the person can settle it, asks them in plain words.
 *
 * It runs on the board's PM agent (the top-bar chat's) and only on an API
 * agent: a CLI one would mean a GitHub Actions job per check. See
 * docs/plans/craft-and-direction.md.
 */

export const PM = "The PM";

/** How much of a change's diff the PM reads. Enough to judge intent, not to review code. */
const MAX_DIFF = 40_000;
/** How much of the design document it reads. */
const MAX_DESIGN = 6_000;
/** Where a repository's design document usually lives. */
const DESIGN_PATHS = ["DESIGN.md", "design/DESIGN.md", "docs/DESIGN.md", "docs/design.md"];

const PM_BRIEF = `You are the PM: the project manager who directs this board's agents for the person who owns it, the stakeholder. You hold their vision. The Product Agent writes the PRD, the Architect plans tickets, the Coder builds and the Reviewer checks, and each of them sees mostly the step before it. You see what the person actually asked for, and you make sure it is what they get.

You are checking one piece of work against the person's own words, the PRD and the product's design. Ask yourself:
- Is every explicit choice the person made (a gesture, a name, a number, a behaviour, a phrase) honoured? A substitute is not honoured, even a reasonable one.
- Was anything added that they did not ask for and that works against what they asked?
- For anything a person sees or touches: does it look like part of this product and feel good to use, or generic and awkward?
- Would the person be proud to show this, or disappointed?

Most work is on track: then say so and nothing else. Never nitpick code style, and never repeat what a reviewer will catch anyway (tests, types, lint).

When it drifts, step in. Write forTheAgents: a short, specific correction for the agent doing the work next, naming exactly what the person asked for that is missing or wrong and what to do instead. When it drifts in a way only the person can settle (two things they asked for conflict, or a trade-off between scope and time), ask them instead in forThePerson: one question in plain, friendly, non-technical words, with why it matters. Translate: no file names, no jargon.

Answer with one JSON object and nothing else:
{"onTrack": true | false, "forTheAgents": "<correction>" | null, "forThePerson": {"question": "<question>", "why": "<why>"} | null}`;

const verdictSchema = z.object({
  onTrack: z.boolean(),
  forTheAgents: z.string().nullable().default(null),
  forThePerson: agentQuestionSchema.nullable().default(null),
});

export type PmVerdict =
  | { kind: "on_track" }
  | { kind: "correct"; note: string }
  | { kind: "ask"; question: AgentQuestion; note: string | null };

/** The PM's judgement of one piece of work, or null when it has no agent to judge with or cannot answer. */
export async function judge(projectId: string, work: string): Promise<PmVerdict | null> {
  const agent = await assistantAgentFor(projectId);
  if (agent.kind !== "api") return null;
  const system = `${PM_BRIEF}\n\n${DESIGN_RULE}${agent.brief ? `\n\nThe person's instructions for you:\n${agent.brief}` : ""}`;
  const past = [{ role: "user" as const, content: work }];
  let speak: Speak;
  if (agent.info.kind === "anthropic") {
    speak = claudeSpeak(agent.apiKey, agent.model ?? MODELS.product, system, past, []);
  } else {
    if (!agent.apiKey || !agent.model) return null;
    speak = openAiSpeak(agent.info, agent.apiKey, agent.model, system, past, []);
  }
  const ran = await runChatLoop({ speak, runTool: async () => ({ content: "", isError: true }), maxTurns: 1, budgetMs: 120_000 });
  if (ran.end !== "answered") return null;
  let raw: unknown;
  try {
    raw = extractJson(ran.text);
  } catch {
    return null;
  }
  const parsed = verdictSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { onTrack, forTheAgents, forThePerson } = parsed.data;
  const note = forTheAgents?.trim() || null;
  if (forThePerson?.question.trim()) return { kind: "ask", question: forThePerson, note };
  if (!onTrack && note) return { kind: "correct", note };
  return { kind: "on_track" };
}

/** The product's design document, if the repository has one, cut to what the PM reads. */
async function designDoc(client: VcsClient, ref: string): Promise<string | null> {
  for (const path of DESIGN_PATHS) {
    const text = await client.readFile(path, ref).catch(() => null);
    if (text?.trim()) return `${path}:\n${text.slice(0, MAX_DESIGN)}`;
  }
  return null;
}

/** What the PM says in a card's chat when it steps in. */
export function pmMessage(text: string): string {
  return `**PM:** ${text.trim()}`;
}

async function sayInChat(projectId: string, cardKind: "epic" | "ticket", cardId: string, text: string): Promise<void> {
  await repository().addCardChatMessage({ projectId, cardKind, cardId, role: "assistant", content: pmMessage(text) });
}

/**
 * A ticket's change has reached review. Returns the reason to stall it on, a
 * question for the person, or null to let the review go ahead (with the PM's
 * correction, if any, among the ticket's notes for the Reviewer to read).
 */
export async function overseeChange(
  projectId: string,
  ticket: { id: string; key: string; title: string; description: string; acceptanceCriteria: string[] },
  origin: Origin | undefined,
  change: { client: VcsClient; base: string; head: string; ref: string },
): Promise<string | null> {
  if (!origin) return null;
  const compared = await change.client.compare(change.base, change.head).catch(() => null);
  if (!compared || compared.files.length === 0) return null;
  let diff = (compared.patches ?? []).map((p) => `--- ${p.path}\n${p.patch}`).join("\n\n");
  if (diff.length > MAX_DIFF) diff = `${diff.slice(0, MAX_DIFF)}\n… (cut)`;
  const design = await designDoc(change.client, change.ref);
  const work = [
    ...originLines(origin),
    "",
    `The ticket, ${ticket.key}: ${ticket.title}`,
    ticket.description,
    "Acceptance criteria:",
    ...ticket.acceptanceCriteria.map((c) => `- ${c}`),
    "",
    `The change it made, files: ${compared.files.join(", ")}`,
    diff || "(no patches)",
    ...(design ? ["", "The product's design document:", design] : []),
    "",
    "Judge this change against what the person asked for. forTheAgents goes to the Reviewer, who reviews it next and can send it back.",
  ].join("\n");
  const verdict = await judge(projectId, work).catch(() => null);
  if (!verdict || verdict.kind === "on_track") return null;
  if (verdict.note) {
    await addNote(projectId, ticket.id, `From the PM: ${verdict.note}`);
    await sayInChat(projectId, "ticket", ticket.id, verdict.note);
  }
  return verdict.kind === "ask" ? questionReason(PM, [verdict.question]) : null;
}

/**
 * An Epic's tickets are planned and not yet applied. Returns what to do:
 * apply them, plan again with the PM's correction among the Epic's notes, or
 * wait on a question for the person.
 */
export async function overseeBreakdown(
  projectId: string,
  epicId: string,
  origin: Origin | undefined,
  tickets: Array<{ key: string; title: string; description: string; acceptanceCriteria: string[] }>,
  options: { correctedBefore: boolean },
): Promise<{ kind: "apply" } | { kind: "replan" } | { kind: "ask"; reason: string }> {
  if (!origin) return { kind: "apply" };
  const work = [
    ...originLines(origin),
    "",
    "The Architect's plan:",
    ...tickets.flatMap((t) => [`${t.key}: ${t.title}`, t.description, ...t.acceptanceCriteria.map((c) => `- ${c}`), ""]),
    "Judge this plan against what the person asked for. forTheAgents goes to the Architect, who plans again with it.",
  ].join("\n");
  const verdict = await judge(projectId, work).catch(() => null);
  if (!verdict || verdict.kind === "on_track") return { kind: "apply" };
  if (verdict.kind === "ask") {
    if (verdict.note) await sayInChat(projectId, "epic", epicId, verdict.note);
    return { kind: "ask", reason: questionReason(PM, [verdict.question]) };
  }
  // One correction per plan: a second disagreement goes ahead rather than
  // looping, with the PM's word in the chat for the person to see.
  await sayInChat(projectId, "epic", epicId, verdict.note);
  if (options.correctedBefore) return { kind: "apply" };
  await addEpicNote(projectId, epicId, `${PM_NOTE_PREFIX}${verdict.note}`);
  return { kind: "replan" };
}

/** How the PM's corrections start among an Epic's notes, so a second plan is not corrected again. */
export const PM_NOTE_PREFIX = "From the PM: ";
