import "server-only";

import { z } from "zod";

import { MODELS } from "./anthropic";
import { applyCardAction, cardActionSchema, CARD_ACTIONS_GUIDE, type CardAction } from "./card-actions";
import { scopeAsked } from "@/lib/coder/scope-request";
import { claudeSpeak, openAiSpeak, type Speak, type ToolDef } from "./chat-loop";
import { truncate } from "./coding-loop";
import { launch } from "./pipeline";
import { columnChatAgentFor } from "./presets";
import { addEpicNote } from "./epic-notes";
import { credentialsForProject } from "@/lib/auth/credentials";
import { projectFor } from "@/lib/board/project";
import { addNote } from "@/lib/coder/notes";
import { publish } from "@/lib/events/bus";
import { repository } from "@/lib/db";
import type { CardChatMessage } from "@/lib/db/repository";
import { COLUMN_AGENT_ROLE, AGENT_ROLE_LABELS, type BoardCard } from "@/lib/domain/entities";
import type { FormicEvent } from "@/lib/domain/events";
import { COLUMN_LABELS, columnFor, columnOf, isStalled } from "@/lib/domain/status";
import { ACTIVITY_EVENTS, activityOf } from "@/lib/domain/ticket-view";
import { extractJson } from "@/lib/llm/openai-compat";
import { vcs, type VcsClient } from "@/lib/vcs";

/**
 * One turn of a card's chat. Whatever column the card is in, the person is
 * talking to the agent they set for that column, whatever it runs on: it
 * knows the card, what is going on with it and what was said before, and it
 * can act on it (move it, close it, redo its work with new instructions,
 * rewrite it) as well as answer. A built-in agent answers here and now; a
 * CLI agent answers from GitHub Actions, a minute or two later.
 *
 * Every message is also kept as a note, so any agent working the card now,
 * and every later run of it, reads it too.
 */

const MAX_TURNS = 12;
const MAX_FILES_LISTED = 400;
const MAX_ACTIVITY = 25;

/**
 * How long one chat answer may spend before it stops and writes what it
 * reached. Under the chat routes' `maxDuration` (300s on Vercel) with room
 * left for the call in flight, the way a run's own budget stays under it
 * (see DEFAULT_RUN_BUDGET in budget/limits.ts): an answer that stops itself
 * says what it read and did, and one the platform kills outright says
 * nothing, leaving its message pending forever — which locks the chat, since
 * `ask` refuses while an answer is pending.
 */
export const CHAT_ANSWER_BUDGET_MS = 4 * 60_000;

/**
 * A plain "go again" to a stopped card. It needs no agent to understand, and
 * leaving it to one risks a reply that says the card is starting while
 * nothing starts, or no answer at all when that agent is out of tokens.
 */
const GO_AGAIN =
  /^(?:please\s+)?(?:continue|resume|retry|try again|go again|go ahead|carry on|keep going|restart|start again|pick (?:it )?(?:back )?up)(?:\s+please)?[\s.!]*$/i;

export function isGoAgain(text: string): boolean {
  return GO_AGAIN.test(text.trim());
}

const MAX_LISTED_FILES = 6;

/** The files an answer read, as a sentence to append, or "" when it read none. */
function readList(files: string[]): string {
  if (files.length === 0) return "";
  const shown = files.slice(0, MAX_LISTED_FILES).join(", ");
  return ` I read ${files.length === 1 ? "1 file" : `${files.length} files`}: ${shown}${
    files.length > MAX_LISTED_FILES ? `, and ${files.length - MAX_LISTED_FILES} more` : ""
  }.`;
}

/**
 * What the person is told when the answer used every round without closing.
 * The old wording — "I read a lot and did not reach an answer" — hid the
 * reading the model had just done, and the rounds it spent doing it. The last
 * round is now spent on the answer instead (`Speak`'s `answerOnly`), and this
 * says what that cost and what was read.
 */
export function outOfRoundsReply(rounds: number, files: string[], said: string): string {
  const read = readList(files);
  const body = said.trim();
  if (!body) {
    return `I used all ${rounds} rounds and did not reach an answer.${read} Ask me again, narrower, or name the file and section you mean.`;
  }
  return `${body}\n\nI used all ${rounds} rounds getting there.${read}`;
}

/**
 * What the person is told when the answer ran out of its clock rather than
 * its rounds: what it reached, and what it read getting there. Its own words
 * rather than an apology, and the same offer to be asked again.
 */
export function outOfTimeReply(limitMs: number, files: string[], said: string): string {
  const read = readList(files);
  const limit = `${Math.round(limitMs / 60_000)} minute limit`;
  const body = said.trim();
  if (!body) {
    return `I ran out of time (${limit}) before I reached an answer.${read} Ask me again, narrower, or name the file and section you mean.`;
  }
  return `${body}\n\nI ran out of time (${limit}) before I finished.${read}`;
}

const listInput = z.object({ prefix: z.string().optional() });
const readInput = z.object({ path: z.string().min(1) });
const actInput = z.object({ action: z.unknown() });

const TOOL_DEFS: ToolDef[] = [
  {
    name: "list_files",
    description:
      "List the repository's files on the base branch. Give a directory prefix such as \"src/lib\" to narrow it.",
    schema: {
      type: "object",
      properties: { prefix: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: "Read one file from the repository's base branch, by its path from the root.",
    schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "act",
    description:
      "Do something to this card: move, close, redo, stop, edit_ticket or needs_human. It happens at once, and the result says what happened.",
    schema: {
      type: "object",
      properties: { action: z.toJSONSchema(cardActionSchema) },
      required: ["action"],
      additionalProperties: false,
    },
  },
];

/* ------------------------------------------------------------------------ */
/* What the agent knows: the card, and what is going on with it.            */
/* ------------------------------------------------------------------------ */

function whereItIs(card: BoardCard): string[] {
  const column = columnOf(card);
  const lines = [`Column: ${COLUMN_LABELS[column]} (status: ${card.status}).`];
  if (card.workingSince) {
    lines.push(
      `An agent is working on it right now${card.agentRole ? ` (the ${AGENT_ROLE_LABELS[card.agentRole]} Agent)` : ""}, since ${card.workingSince}.`,
    );
  } else {
    lines.push("No agent is working on it right now.");
  }
  if (card.misplacedReason) lines.push(`It cannot work where it is: ${card.misplacedReason}`);
  if (card.blockedReason) {
    lines.push(
      card.status === "blocked" || card.status === "failed"
        ? `It stopped, and waits for the person: ${card.blockedReason}`
        : `It waits: ${card.blockedReason}`,
    );
  }
  return lines;
}

async function ticketContext(card: BoardCard): Promise<string> {
  const repo = repository();
  const detail = await repo.ticketDetail(card.id);
  if (!detail) return "(This ticket could not be loaded.)";
  const cards = await repo.boardCards(detail.projectId);
  const epic = cards.find((c) => c.id === detail.epicId);
  const deps = card.dependsOn
    .map((id) => cards.find((c) => c.id === id))
    .filter((c): c is BoardCard => !!c)
    .map((c) => `${c.key} (${c.status})`);

  const events = await repo.ticketEvents(detail.projectId, card.id, [...ACTIVITY_EVENTS], 200);
  const activity = events
    .map((e) => activityOf(e.payload as FormicEvent, card.id, e.seq, e.at.toISOString()))
    .filter((a) => !!a)
    .slice(-MAX_ACTIVITY)
    .map((a) => {
      const who = a.kind === "note" ? "Person" : a.kind === "reply" ? (a.agent ?? "Formic") : "Agent";
      return `- ${who}${a.kind === "action" ? " did" : ""}: ${truncate(a.text, 400).replace(/\s+/g, " ")}`;
    });

  return [
    `Ticket ${detail.key}: ${detail.title}`,
    ...(epic ? [`In Epic ${epic.key}: ${epic.title}`] : []),
    ...whereItIs(card),
    ...(detail.needsHuman ? [`It is marked as work for the person, not an agent: ${detail.needsHuman}`] : []),
    ...(scopeAsked(detail).length
      ? [
          `It asks the person for files outside its file scope: ${scopeAsked(detail).join(", ")}. Their yes or no to that is widen_scope.`,
        ]
      : []),
    ...(detail.prNumber ? [`Pull request: #${detail.prNumber} ${detail.prUrl ?? ""}`.trim()] : []),
    ...(detail.branchName ? [`Branch: ${detail.branchName}`] : []),
    ...(detail.summary ? [`What was done: ${detail.summary}`] : []),
    ...(deps.length ? [`Waits on: ${deps.join(", ")}`] : []),
    ...(detail.plan.length
      ? ["Plan:", ...detail.plan.map((s) => `- [${s.status === "done" ? "x" : " "}] ${s.step}`)]
      : []),
    "",
    detail.description,
    ...(detail.acceptanceCriteria.length
      ? ["", "Acceptance criteria:", ...detail.acceptanceCriteria.map((c) => `- ${c}`)]
      : []),
    "",
    `File scope: ${detail.fileScope.join(", ") || "(none)"}`,
    ...(activity.length ? ["", "What happened on it lately, oldest first:", ...activity] : []),
  ].join("\n");
}

async function epicContext(card: BoardCard): Promise<string> {
  const repo = repository();
  const detail = await repo.epicDetail(card.id);
  if (!detail) return "(This Epic could not be loaded.)";
  const tickets = await repo.ticketsForEpic(card.id);
  return [
    `Epic ${card.key}: ${detail.title}`,
    ...whereItIs(card),
    "",
    "The person's original request:",
    detail.rawRequest,
    ...(detail.prd
      ? ["", "Its PRD, as JSON:", truncate(JSON.stringify(detail.prd, null, 2), 6_000)]
      : ["", "It has no PRD yet."]),
    ...(tickets.length
      ? [
          "",
          "Its tickets:",
          ...tickets.map(
            (t) =>
              `- ${t.key} [${COLUMN_LABELS[columnFor(t.status, t.stalledIn)]} · ${t.status}] ${t.title}${t.needsHuman ? " (work for the person)" : ""}`,
          ),
        ]
      : []),
  ].join("\n");
}

async function systemPrompt(
  card: BoardCard,
  repoFullName: string,
  brief: string | null,
): Promise<string> {
  const column = columnFor(card.status, card.stalledIn);
  const role = AGENT_ROLE_LABELS[COLUMN_AGENT_ROLE[column]];
  const what = card.kind === "epic" ? "Epic" : "ticket";
  return [
    `You are the ${role} Agent: the agent the person set for the ${COLUMN_LABELS[column]} column of a Formic board for the GitHub repository ${repoFullName}. This ${what} is in ${COLUMN_LABELS[column]}, so it is yours, and the person is talking to you about it in its chat. Whatever they ask about it, you handle.`,
    ...(brief ? ["", "Your instructions for this column's work:", brief.trim()] : []),
    "",
    "Read the repository before you answer a question about its code. Do not guess at what a file contains.",
    "",
    CARD_ACTIONS_GUIDE,
    "",
    "Answer in short, plain Markdown.",
    "",
    `The ${what} now:`,
    card.kind === "epic" ? await epicContext(card) : await ticketContext(card),
  ].join("\n");
}

function history(messages: CardChatMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  return messages
    .filter((m) => m.status === "done" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));
}

/* ------------------------------------------------------------------------ */
/* A built-in agent answers here, with tools.                                */
/* ------------------------------------------------------------------------ */

async function runTool(
  call: { name: string; input: unknown },
  client: VcsClient,
  ref: string,
  act: (action: CardAction) => Promise<string>,
): Promise<{ content: string; isError: boolean }> {
  try {
    if (call.name === "list_files") {
      const { prefix } = listInput.parse(call.input ?? {});
      const clean = (prefix ?? "").replace(/^\/+|\/+$/g, "");
      const files = (await client.listFiles(ref)).filter((f) => !clean || f === clean || f.startsWith(`${clean}/`));
      const shown = files.slice(0, MAX_FILES_LISTED);
      return {
        content:
          shown.join("\n") +
          (files.length > shown.length ? `\n… and ${files.length - shown.length} more. Narrow the prefix.` : "") ||
          "No files there.",
        isError: false,
      };
    }
    if (call.name === "read_file") {
      const { path } = readInput.parse(call.input);
      const text = await client.readFile(path.replace(/^\/+/, ""), ref);
      return text === null
        ? { content: `${path} does not exist on ${ref}.`, isError: true }
        : { content: truncate(text), isError: false };
    }
    if (call.name === "act") {
      const parsed = cardActionSchema.safeParse(actInput.parse(call.input).action);
      if (!parsed.success) {
        return {
          content: `Not done: ${parsed.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
          isError: true,
        };
      }
      return { content: await act(parsed.data), isError: false };
    }
    return { content: `There is no tool called ${call.name}.`, isError: true };
  } catch (e) {
    return { content: e instanceof Error ? e.message : String(e), isError: true };
  }
}

async function finish(
  messageId: string,
  update: {
    content: string;
    status: "done" | "failed";
    /**
     * What the answer spent, for the one that was made here. A CLI agent's
     * answer passes none: its spend is its job's run (see finishCliCardChat).
     */
    tokensIn?: number;
    tokensOut?: number;
    costCents?: number;
  },
): Promise<void> {
  await repository().updateCardChatMessage(messageId, {
    content: update.content,
    status: update.status,
    runnerJob: null,
    runnerAgent: null,
    ...(update.tokensIn === undefined
      ? {}
      : { tokensIn: update.tokensIn, tokensOut: update.tokensOut ?? 0, costCents: update.costCents ?? 0 }),
  });
}

/**
 * Answers the pending chat message `messageId` on a card. Never throws: a
 * failure becomes the message, so the person sees what went wrong.
 */
export async function answer(
  cardKind: "epic" | "ticket",
  cardId: string,
  messageId: string,
): Promise<void> {
  // Who answers is the column's agent when the message came in, even when
  // what it does moves the card on to another column's.
  const repo = repository();
  const card = await repo.cardById(cardId);
  const label = card ? agentLabelFor(card) : null;
  const projectId = await repo.projectOfCard(cardId);
  // The board puts a crew on a card whose chat is being answered, the way it
  // does for a run: the drawer's "Answering…" is the only other sign, and it
  // only exists inside the drawer.
  await announcing(projectId, cardKind, cardId, "answering");
  // A CLI agent answers from GitHub Actions minutes later. Its crew stays on
  // the card until the answer lands, which is what finishCliCardChat says.
  let answeredLater = false;
  try {
    const outcome = await reply(cardKind, cardId, messageId);
    answeredLater = outcome === "later";
    if (cardKind === "ticket" && !answeredLater) {
      await logReply(cardId, messageId, outcome === "agent" ? label : null);
    }
  } finally {
    if (!answeredLater) await announcing(projectId, cardKind, cardId, "idle");
  }
}

/** Tells the board a card's chat is being worked on, or that it has landed. */
async function announcing(
  projectId: string | null,
  kind: "epic" | "ticket",
  cardId: string,
  state: "answering" | "idle",
): Promise<void> {
  if (projectId) await publish(projectId, { type: "card.chat", cardId, kind, state });
}

/**
 * A ticket's chat shows in its log, beside the notes a person sends: the
 * answer goes there too, so one feed holds the whole conversation.
 */
async function logReply(ticketId: string, messageId: string, agentLabel: string | null): Promise<void> {
  const repo = repository();
  const [message, projectId] = await Promise.all([repo.cardChatMessage(messageId), repo.projectOfCard(ticketId)]);
  if (!message?.content.trim() || !projectId) return;
  await publish(projectId, {
    type: "ticket.reply",
    ticketId,
    agent: agentLabel ? `${agentLabel} Agent` : null,
    text: message.content,
  });
}

/** The agent a card's column runs, by role: who answers in its chat. */
function agentLabelFor(card: BoardCard): string {
  return AGENT_ROLE_LABELS[COLUMN_AGENT_ROLE[columnFor(card.status, card.stalledIn)]];
}

/**
 * Answers the message: "agent" when the column's agent did, "notice" for a
 * reason it could not, "later" when a CLI agent answers from GitHub Actions.
 */
async function reply(
  cardKind: "epic" | "ticket",
  cardId: string,
  messageId: string,
): Promise<"agent" | "notice" | "later"> {
  const repo = repository();
  // What this answer spent, counted turn by turn. An answer is not a run — it
  // moves no card and leaves no run row — so nothing else writes its tokens or
  // its cost down: the message it lands on is the only record of it. Declared
  // out here so a failure below still says what it cost before it failed.
  let tokensIn = 0;
  let tokensOut = 0;
  let costCents = 0;
  const spent = () => ({ tokensIn, tokensOut, costCents });
  try {
    const card = await repo.cardById(cardId);
    const projectId = await repo.projectOfCard(cardId);
    if (!card || !projectId) {
      await finish(messageId, { content: "This card no longer exists.", status: "failed" });
      return "notice";
    }
    const all = await repo.cardChatMessages(cardId);
    const asked = all.filter((m) => m.role === "user").at(-1);
    if (isStalled(card.status) && !card.misplacedIn && asked && isGoAgain(asked.content)) {
      const done = await applyCardAction(projectId, cardKind, cardId, { type: "move", to: columnOf(card) });
      await finish(messageId, { content: done, status: "done" });
      return "notice";
    }

    const column = columnFor(card.status, card.stalledIn);
    const agent = await columnChatAgentFor(projectId, column);

    if (agent.kind === "none" || agent.kind === "limited") {
      await finish(
        messageId,
        cardKind === "ticket"
          ? { content: `${agent.reason} Your message is kept as a note for the agent working this ticket.`, status: "done" }
          : { content: agent.reason, status: "failed" },
      );
      return "notice";
    }

    const project = await projectFor(projectId);
    const past = history(all.filter((m) => m.id !== messageId));
    const brief = agent.kind === "cli" ? agent.agent.brief : agent.brief;
    const system = await systemPrompt(card, project.repoFullName, brief);

    if (agent.kind === "cli") {
      const { startCliCardChat } = await import("@/lib/runner/runner");
      const failure = await startCliCardChat({
        projectId,
        messageId,
        cardKey: card.key,
        agent: agent.agent,
        prompt: cliPrompt(system, past),
      });
      if (failure) {
        await finish(messageId, { content: failure, status: "failed" });
        return "notice";
      }
      const waiting = `${agent.agent.info.label.split(" (")[0]} is reading this in GitHub Actions. Its answer lands here in a minute or two.`;
      await repo.updateCardChatMessage(messageId, { content: waiting });
      if (cardKind === "ticket") {
        await publish(projectId, { type: "ticket.reply", ticketId: cardId, agent: null, text: waiting });
      }
      return "later";
    }

    const { info } = agent;
    let speak: Speak;
    if (info.kind === "anthropic") {
      speak = claudeSpeak(agent.apiKey, agent.model ?? MODELS.product, system, past, TOOL_DEFS);
    } else {
      if (!agent.apiKey) throw new Error(`This agent has no ${info.label} API key. Edit it and add one.`);
      if (!agent.model) throw new Error(`This agent has no ${info.label} model. Edit it and pick one.`);
      speak = openAiSpeak(info, agent.apiKey, agent.model, system, past, TOOL_DEFS);
    }

    const creds = await credentialsForProject(project);
    const client = vcs(project.repoFullName, creds.githubToken);
    const done: string[] = [];
    /** The files it read, so a turn that runs out of rounds can say which. */
    const read = new Set<string>();
    const act = async (action: CardAction) => {
      const result = await applyCardAction(projectId, cardKind, cardId, action);
      done.push(result);
      return result;
    };

    let results: Array<{ id: string; content: string; isError: boolean }> | null = null;
    const startedAt = Date.now();
    let ranOutOfTime = false;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // Before the call, not after: the route's own maxDuration is the hard
      // stop past this, and a killed function writes nothing at all — the
      // message stays pending and the chat is locked against new questions.
      if (Date.now() - startedAt >= CHAT_ANSWER_BUDGET_MS) {
        ranOutOfTime = true;
        break;
      }
      const { text, calls, usage } = await speak(results);
      tokensIn += usage.tokensIn;
      tokensOut += usage.tokensOut;
      costCents += usage.costCents;
      if (calls.length === 0) {
        await finish(messageId, {
          content: text || done.join("\n") || "I have nothing to add.",
          status: "done",
          ...spent(),
        });
        return "agent";
      }
      results = [];
      for (const call of calls) {
        if (call.name === "read_file") {
          const path = (call.input as { path?: unknown } | null)?.path;
          if (typeof path === "string" && path.trim()) read.add(path.trim());
        }
        results.push({ id: call.id, ...(await runTool(call, client, project.baseBranch, act)) });
      }
    }
    // Out of clock, so there is no last round to spend: say what was reached
    // and what was read, and let the person ask again.
    if (ranOutOfTime) {
      const said = done.join("\n");
      await finish(messageId, {
        content: outOfTimeReply(CHAT_ANSWER_BUDGET_MS, [...read], said),
        status: said.trim() ? "done" : "failed",
        ...spent(),
      });
      return "agent";
    }
    // Every round went on reading, and the model never stopped to answer. It
    // has what it read; give it one last turn with no tools, so the turn ends
    // in an answer rather than in an apology for not giving one.
    const closing = await speak(null, { answerOnly: true });
    tokensIn += closing.usage.tokensIn;
    tokensOut += closing.usage.tokensOut;
    costCents += closing.usage.costCents;
    const said = closing.text.trim() || done.join("\n");
    await finish(messageId, {
      content: outOfRoundsReply(MAX_TURNS, [...read], said),
      status: said.trim() ? "done" : "failed",
      ...spent(),
    });
    return "agent";
  } catch (e) {
    await finish(messageId, {
      content: e instanceof Error ? e.message : String(e),
      status: "failed",
      ...spent(),
    });
    return "notice";
  }
}

/* ------------------------------------------------------------------------ */
/* A CLI agent answers in GitHub Actions, where it can read the checkout.    */
/* ------------------------------------------------------------------------ */

const cliAnswerSchema = z.object({
  reply: z.string(),
  actions: z.array(z.unknown()).default([]),
});

export function cliPrompt(
  system: string,
  past: Array<{ role: "user" | "assistant"; content: string }>,
): string {
  return [
    system,
    "",
    "You are running in a checkout of the repository: read it directly.",
    "",
    "The conversation so far, oldest first. Answer the last message from the person.",
    "",
    ...past.map((m) => `### ${m.role === "user" ? "Person" : "You"}\n${m.content}\n`),
    "How to answer:",
    "- Do not change, create or delete any file in the repository. Nothing you change is kept.",
    "- Write your answer to the file named by the FORMIC_OUTPUT environment variable, as one JSON object and nothing else:",
    '  {"reply": "<your answer, in Markdown>", "actions": [<an action>, ...]}',
    "- Your reply alone changes nothing on the board: only actions do. Never say the card is moving, starting or stopping unless the action that does it is in actions.",
    "- Formic carries out the actions in order once you finish, and adds what happened under your reply, so write the reply as what you are doing (\"Closing it now.\"), not as a question.",
    "- Leave actions empty unless the person asked for something to be done. Each action matches this JSON Schema:",
    JSON.stringify(z.toJSONSchema(cardActionSchema)),
  ].join("\n");
}

/**
 * A CLI agent's answer arrived, or its run failed: carries out what it
 * decided and shows its reply with what happened.
 *
 * No tokens or cost are written on the message: the Actions job it ran in is
 * its run, and that run is what its spend is counted against.
 */
export async function finishCliCardChat(
  messageId: string,
  answerText: string | null,
  failure?: string,
): Promise<void> {
  const repo = repository();
  const message = await repo.cardChatMessage(messageId);
  if (!message) return;
  const { projectId, cardKind, cardId } = message;
  const card = await repo.cardById(cardId);
  const label = card && !failure && answerText?.trim() ? agentLabelFor(card) : null;

  if (failure || !answerText?.trim()) {
    await finish(messageId, { content: failure ?? "The agent finished without an answer.", status: "failed" });
  } else {
    let raw: unknown = null;
    try {
      raw = extractJson(answerText);
    } catch {
      // Not JSON: the text is the reply.
    }
    const parsed = cliAnswerSchema.safeParse(raw);
    if (!parsed.success) {
      await finish(messageId, { content: answerText.trim(), status: "done" });
    } else {
      const lines: string[] = [];
      for (const candidate of parsed.data.actions) {
        const action = cardActionSchema.safeParse(candidate);
        lines.push(
          action.success
            ? await applyCardAction(projectId, cardKind, cardId, action.data)
            : `_Formic could not use one of the agent's actions: ${action.error.issues[0]?.message ?? "it was malformed"}._`,
        );
      }
      await finish(messageId, {
        content: [parsed.data.reply.trim(), ...lines].filter(Boolean).join("\n\n") || "I have nothing to add.",
        status: "done",
      });
    }
  }
  if (cardKind === "ticket") await logReply(cardId, messageId, label);
  // The answer has landed, so the crew reading the card walks home.
  await announcing(projectId, cardKind, cardId, "idle");
}

/* ------------------------------------------------------------------------ */
/* Sending.                                                                  */
/* ------------------------------------------------------------------------ */

export class ChatBusyError extends Error {
  constructor() {
    super("The agent is still answering the last message.");
  }
}

/**
 * Sends the person's message on a card's chat and starts the reply. It is
 * also kept as a note, so the agent working the card, and every later run
 * of it, reads it whether or not the column's agent acts on it.
 */
export async function ask(
  projectId: string,
  cardKind: "epic" | "ticket",
  cardId: string,
  text: string,
): Promise<void> {
  const repo = repository();
  if ((await repo.cardChatMessages(cardId)).some((m) => m.status === "pending")) {
    throw new ChatBusyError();
  }
  await repo.addCardChatMessage({ projectId, cardKind, cardId, role: "user", content: text });
  if (cardKind === "ticket") await addNote(projectId, cardId, text);
  if (cardKind === "epic") await addEpicNote(projectId, cardId, text);
  const pending = await repo.addCardChatMessage({
    projectId,
    cardKind,
    cardId,
    role: "assistant",
    content: "",
    status: "pending",
  });
  launch(() => answer(cardKind, cardId, pending.id), `${cardKind} chat answer ${pending.id}`);
}
