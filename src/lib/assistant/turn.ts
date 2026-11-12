import "server-only";

import { z } from "zod";

import { MODELS } from "@/lib/agents/anthropic";
import { claudeSpeak, openAiSpeak, runChatLoop, type Speak, type ToolCall, type ToolDef } from "@/lib/agents/chat-loop";
import {
  ask as askCardChat,
  CHAT_ANSWER_BUDGET_MS,
  FILE_TOOL_DEFS,
  outOfRoundsReply,
  outOfTimeReply,
  runTool as runFileTool,
} from "@/lib/agents/card-chat";
import { launch } from "@/lib/agents/pipeline";
import { assistantAgentFor, columnChatAgentFor } from "@/lib/agents/presets";
import { credentialsForProject } from "@/lib/auth/credentials";
import { projectFor } from "@/lib/board/project";
import { attemptsFor } from "@/lib/budget/in-process";
import { repository } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { columnOf } from "@/lib/domain/status";
import type { AssistantMessage, AssistantProposal } from "@/lib/db/repository";
import { extractJson } from "@/lib/llm/openai-compat";
import { startCliAsk } from "@/lib/runner/runner";
import { vcs, type VcsClient } from "@/lib/vcs";
import { ASSISTANT_BRANCH_PREFIX, assistantActionSchema, checkAction } from "./actions";
import { boardSnapshot, cardReport, mentionedKeys } from "./context";
import { outOfRoundsMessage, readWindow } from "./reads";
import {
  ACT_ON_CARD_DEF,
  actOnCardInput,
  actOnColumnCard,
  columnOfSpeaker,
  columnSystemPrompt,
  quickVoice,
  sentinelOfSpeaker,
  sentinelSystemPrompt,
} from "./guests";
import { guestLabel, type GuestId } from "@/lib/assistant/guest-ids";
import type { AgentRole } from "@/lib/domain/entities";
import { DESIGN_RULE, ENGINEERING_PRACTICES, TICKET_TEMPLATE } from "@/lib/agents/prompts";
import { askedIn, isQuestion, PM_ANSWER_PREFIX } from "@/lib/domain/question";
import type { BoardCard } from "@/lib/domain/entities";

/**
 * One turn of the board's assistant: the person asked something, the agent
 * they picked answers it.
 *
 * It can read the repository, the board and each card's live state on
 * GitHub, and it can propose changes, which wait for the person's approval.
 * It can also change the code itself, on a branch of its own: the change
 * becomes a pull request when the person approves it, and goes through CI
 * and review like any other. Work too big for one conversation is tickets.
 */

const MAX_TURNS = 16;
/** The answer stops itself here, inside the route's maxDuration, so the message never stays pending. */
export const MAX_ANSWER_MS = CHAT_ANSWER_BUDGET_MS;
const MAX_FILES_LISTED = 400;

const listInput = z.object({ prefix: z.string().optional() });
const readInput = z.object({ path: z.string().min(1), offset: z.number().int().min(0).optional() });
const proposeInput = z.object({ summary: z.string().min(1), action: z.unknown() });
const cardInput = z.object({ key: z.string().min(1) });
const writeInput = z.object({ path: z.string().min(1), content: z.string(), message: z.string().optional() });
const answerInput = z.object({ key: z.string().min(1), answer: z.string().trim().min(1), own: z.boolean().default(false) });

/** The branch one answer's code change goes on: by its message, or its job's nonce for a CLI agent. */
export function changeBranchFor(id: string): string {
  return `${ASSISTANT_BRANCH_PREFIX}${id.replace(/[^A-Za-z0-9-]/g, "").slice(-16)}`;
}

/** How many cards' live state a CLI agent is handed up front. */
const MAX_CLI_REPORTS = 4;
/** How many cards in review or blocked it is handed when the person names none. */
const MAX_CLI_FALLBACK_REPORTS = 8;

export const TOOL_DEFS: ToolDef[] = [
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
    description:
      "Read one file from the repository's base branch, by its path from the root. A long file comes back in windows of 16,000 characters: the first line says which part you have, and the last line says the offset that continues it.",
    schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: {
          type: "integer",
          description: "Character to start at, for reading past the first window. Omit for the start of the file.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "card_status",
    description:
      "A card's live state: its column and the reason it shows, whether an agent is on it now, its recent agent runs, its pull request, the checks on its head and the log of a failed one. Use it before saying anything about why a card is where it is.",
    schema: {
      type: "object",
      properties: { key: { type: "string", description: "The card's key, e.g. \"T-94\"." } },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description:
      "Create or replace one file, whole, on your own branch (a commit per call). Read the file first and send its full new text. When the change is done, propose open_pull_request with the branch this returns.",
    schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string", description: "The file's entire new text." },
        message: { type: "string", description: "The commit message." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "answer_question",
    description:
      "Answer a question a card is waiting on, by the card's key. The card's agent starts again with it at once. Passing the person's answer: use their own words, adding only what the agent needs to understand them, and check first that the reply answers each question the card asked; when it is vague, answers only some of them, or raises a new doubt, ask the person a short follow-up instead and call this once the answers are complete, with all of them. Answering yourself, because the person's own words, the PRD, the audit or the design document already settle it: set own to true and say which of them settles it.",
    schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The card's key, e.g. \"EPIC-12\"." },
        answer: { type: "string", description: "The answer." },
        own: { type: "boolean", description: "True when the answer is your own, settled by what the person already asked for; false when it passes on the person's words." },
      },
      required: ["key", "answer"],
      additionalProperties: false,
    },
  },
  {
    name: "propose",
    description:
      "Propose a change to the board. The person sees it with Approve and Dismiss buttons; it only happens if they approve.",
    schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One line the person approves, e.g. \"Add 6 tickets from docs/tickets.md\"." },
        action: z.toJSONSchema(assistantActionSchema),
      },
      required: ["summary", "action"],
      additionalProperties: false,
    },
  },
];

/** The most Epics whose original words the PM is briefed with. */
const MAX_VISIONS = 12;
/** How much of each Epic's original request the PM is briefed with. */
const VISION_CHARS = 600;

/** The questions cards are waiting on, for the PM to relay. */
function openQuestions(cards: BoardCard[]): string[] {
  return cards
    .filter((c) => isQuestion(c.blockedReason))
    .map((c) => `- ${c.key} (${c.title}), asked by ${c.blockedReason!.split("\n")[1]?.split(" is waiting")[0] ?? "an agent"}:\n  ${askedIn(c.blockedReason!).replace(/\n/g, "\n  ")}`);
}

/** What the person asked for, Epic by Epic, for the Epics still being worked on. */
async function visions(cards: BoardCard[]): Promise<string[]> {
  const repo = repository();
  const live = cards.filter((c) => c.kind === "epic" && c.status !== "merged").slice(0, MAX_VISIONS);
  const lines: string[] = [];
  for (const epic of live) {
    const detail = await repo.epicDetail(epic.id);
    const words = detail?.rawRequest.trim().replace(/\s+/g, " ");
    if (words) lines.push(`- ${epic.key} ${epic.title}: "${words.length > VISION_CHARS ? `${words.slice(0, VISION_CHARS)}…` : words}"`);
  }
  return lines;
}

export async function systemPrompt(projectId: string, brief: string | null): Promise<string> {
  const project = await projectFor(projectId);
  const cards = await repository().boardCards(projectId);
  const questions = openQuestions(cards);
  const asked = await visions(cards);
  return [
    `You are the PM: the project manager who directs the agents on a Formic board for the GitHub repository ${project.repoFullName} (base branch ${project.baseBranch}). You work for the person you are talking to, the stakeholder who owns this board. The Product Agent, the Architect, the Coder and the Reviewer each do one column's work; you hold the person's vision across all of it.`,
    "",
    "Your job:",
    "- Keep the work true to what the person asked for, in their own words, and to the product's standards: its design, its tests, its PRDs. You do not check every plan and change yourself: the agents ask when they are unsure, and every question an agent asks comes to you first.",
    "- When an agent asks, settle it if what the person already asked for settles it (their words, the PRD, an audit's checks, the design document): answer with answer_question, own set to true, and tell the person in a line what you answered and why. When only the person can settle it, do not answer: put it to them in plain words with your suggested answer and why, and say they can reply here or in the card's chat.",
    "- Be the person's single point of contact. Put each question that needs them in plain, warm, non-technical words, one at a time, and pass their answer back with answer_question. Before you do, check their reply answers each question the card asked (openQuestions lists them); when it does not (vague, answers only some, or raises a new doubt), ask a short follow-up instead and call answer_question once the answers are complete, with all of them.",
    "- Ask about priorities when work goes off track or two wishes pull against each other, the way a good project manager would: are we building the right thing, in the right order?",
    "- Answer anything about the repository and the work, and do the work yourself when it is quicker.",
    "Speak like a trusted colleague: brief, clear, kind, never technical unless they are.",
    "",
    ...(questions.length
      ? [
          "Questions the board is waiting on the person for. Raise them first, starting with the one holding up the most work, unless the person is asking about something else:",
          ...questions,
          "",
        ]
      : ["No card is waiting on a question right now.", ""]),
    ...(asked.length ? ["What the person asked for, in their own words, for each Epic still in progress:", ...asked, ""] : []),
    "Read the repository before you answer a question about its code. Do not guess at what a file contains.",
    "",
    "You see the board below, and each card's live state on GitHub (its checks, the log of a red one, its agent runs). When asked about a card, look before you answer; never answer that you cannot see it.",
    "",
    "You can do the work, not only describe it. Each of these is a proposal: it happens only if the person approves it.",
    "- open_pull_request, for a change to the code you made yourself, on your own branch. It goes through CI and review like any other pull request. Make the change yourself, without a ticket, when you can finish and check it in this conversation: a bug fix, a follow-up, a small feature.",
    "- rerun_ci, to run a ticket's failed checks again when the failure is not the code's (a network error in an install, a lost runner). A head that does not change never gets new CI, so a card waiting on one stays stuck until it re-runs.",
    "- add_tickets_to_epic, for work that belongs to an Epic already on the board: a follow-up or a bug in a ticket's work goes in that ticket's Epic.",
    "- create_epic_with_tickets, for a new capability that is already planned. An Epic is a user-facing capability: user stories made of several user flows, each flow one or more tickets. One fix is not an Epic, and an Epic of one ticket is almost always wrong: add the ticket to the Epic it belongs to, or make the change yourself. It lands in To Do.",
    "- create_backlog_item, for a request that still needs a PRD. The Product Agent writes one.",
    "- move_card, to move a card to another column. It follows the same rules as the person dragging it, so a move the board refuses (a ticket to Done with no pull request, say) fails: say so rather than propose it.",
    "- close_card, for a card that is no longer needed (a duplicate, work already done elsewhere). A ticket is archived; an Epic is deleted with all its tickets.",
    "A ticket's fileScope lists the directories it may change, as prefixes from the repository root: 1 to 12 entries, so name directories such as \"src/renderer\" rather than every file in them. Tickets that could run at the same time must not share a scope: make one depend on the other instead. Keys are short and stable, such as \"T-1\".",
    "",
    TICKET_TEMPLATE,
    "",
    DESIGN_RULE,
    "",
    ENGINEERING_PRACTICES,
    "",
    `You have ${MAX_TURNS} rounds, one per model call, and an answer that runs out of them is lost. Call propose as soon as you know the ticket list; do not read further to polish it. A thin fileScope is better than no proposal.`,
    "",
    "Answer in short, plain Markdown. After proposing, say in one line what you proposed.",
    "",
    "The board right now:",
    boardSnapshot(cards),
    ...(brief ? ["", "The person's instructions for you:", brief] : []),
  ].join("\n");
}

/** What the reply `messageId` sees: the conversation up to its own message. */
async function historyBefore(projectId: string, messageId: string) {
  const { messages: all } = await repository().assistantMessages(projectId);
  const at = all.findIndex((m) => m.id === messageId);
  const past = history(at < 0 ? all : all.slice(0, at));
  // Another speaker's reply may be the last: the person's question still stands.
  return past.at(-1)?.role === "assistant" ? [...past, { role: "user" as const, content: "Now it is your turn to answer the person's last message." }] : past;
}

/** Earlier messages as plain text, the way every provider accepts them. */
function history(messages: AssistantMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  return messages
    .filter((m) => m.status === "done" && m.content.trim())
    .map((m) => ({
      role: m.role,
      content: [
        m.role === "assistant" && m.speaker !== "assistant" ? `${guestLabel(m.speaker as GuestId)}: ${m.content}` : m.content,
        ...m.proposals.map((p) => `[Proposed: ${p.summary}. The person ${p.state === "proposed" ? "has not decided yet" : p.state === "applied" ? "approved it" : p.state === "dismissed" ? "dismissed it" : "approved it, but it failed"}.]`),
      ].join("\n"),
    }));
}

/**
 * The conversation with a message from Formic itself at its end, such as an
 * agent's question the PM is woken for. It is not kept: the PM's answer is.
 */
function withPrompt(
  past: Array<{ role: "user" | "assistant"; content: string }>,
  prompt: string | undefined,
): Array<{ role: "user" | "assistant"; content: string }> {
  if (!prompt) return past;
  const last = past.at(-1);
  if (last?.role === "user") return [...past.slice(0, -1), { role: "user", content: `${last.content}\n\n${prompt}` }];
  return [...past, { role: "user", content: prompt }];
}

export interface TurnContext {
  projectId: string;
  client: VcsClient;
  ref: string;
  /** Where write_file commits; made from the base on the first write. */
  branch: string;
  wrote: Set<string>;
}

export async function runTool(
  call: ToolCall,
  turn: TurnContext,
  proposals: AssistantProposal[],
): Promise<{ content: string; isError: boolean }> {
  const { client, ref } = turn;
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
      const { path, offset } = readInput.parse(call.input);
      const clean = path.replace(/^\/+/, "");
      const text = await client.readFile(clean, ref);
      return text === null
        ? { content: `${path} does not exist on ${ref}.`, isError: true }
        : { content: readWindow(clean, text, offset ?? 0), isError: false };
    }
    if (call.name === "card_status") {
      const { key } = cardInput.parse(call.input);
      return { content: await cardReport(turn.projectId, key, client), isError: false };
    }
    if (call.name === "write_file") {
      const { path, content, message } = writeInput.parse(call.input);
      const clean = path.replace(/^\/+/, "");
      if (clean.split("/").includes("..")) return { content: "A path may not contain '..'.", isError: true };
      if (clean.startsWith(".github/workflows/")) {
        return { content: "Workflow files cannot be changed from here. Say what to change and the person can do it.", isError: true };
      }
      if (turn.wrote.size === 0) await client.ensureBranch(turn.branch, ref);
      await client.commitFile(turn.branch, clean, content, message?.trim() || `Update ${clean}`);
      turn.wrote.add(clean);
      return {
        content: `Committed ${clean} to ${turn.branch}. When the change is complete, propose open_pull_request with branch "${turn.branch}".`,
        isError: false,
      };
    }
    if (call.name === "answer_question") {
      const { key, answer, own } = answerInput.parse(call.input);
      const card = (await repository().boardCards(turn.projectId)).find((c) => c.key.toLowerCase() === key.trim().toLowerCase());
      if (!card) return { content: `There is no card ${key}.`, isError: true };
      if (!isQuestion(card.blockedReason)) return { content: `${card.key} is not waiting on a question.`, isError: true };
      await askCardChat(turn.projectId, card.kind, card.id, own ? `${PM_ANSWER_PREFIX}${answer}` : answer);
      return { content: `Passed on. ${card.key}'s agent has started again with the answer.`, isError: false };
    }
    if (call.name === "propose") {
      const { summary, action } = proposeInput.parse(call.input);
      const checked = checkAction(action);
      if (!checked.ok) return { content: `Not proposed: ${checked.problem}`, isError: true };
      proposals.push({ summary, action: checked.action, state: "proposed" });
      return {
        content: "Proposed. The person will approve or dismiss it. Do not say it has happened.",
        isError: false,
      };
    }
    return { content: `There is no tool called ${call.name}.`, isError: true };
  } catch (e) {
    return { content: e instanceof Error ? e.message : String(e), isError: true };
  }
}

async function finish(
  messageId: string,
  update: { content: string; proposals?: AssistantProposal[]; status: "done" | "failed" },
): Promise<void> {
  // The person may have stopped this answer while it was being written.
  const current = await repository().assistantMessage(messageId);
  if (!current || current.status !== "pending") return;
  await repository().updateAssistantMessage(messageId, {
    content: update.content,
    proposals: update.proposals ?? [],
    status: update.status,
    runnerJob: null,
    runnerAgent: null,
  });
  // The person may have asked and walked away: tell them it is in.
  await publish(current.projectId, { type: "assistant.message", messageId });
  const { notifyPmAnswer } = await import("@/lib/notifications/notify");
  await notifyPmAnswer(current.projectId, { content: update.content, failed: update.status === "failed" });
  await startNext(current.projectId);
}

/**
 * Starts the earliest reply still pending. Called when an answer finishes,
 * fails or is stopped, so the replies queued behind it go one at a time and
 * in order: the one answering is never pending-and-unfinished when this runs.
 */
export async function startNext(projectId: string): Promise<void> {
  const next = await repository().pendingAssistantMessage(projectId, "assistant");
  if (next) launch(() => answer(projectId, next.id), `assistant answer ${next.id}`);
}

/** The person stopped waiting: the answer being written is failed, and the next one queued starts. */
export async function cancelPending(projectId: string): Promise<void> {
  const repo = repository();
  const current = await repo.pendingAssistantMessage(projectId);
  if (!current) return;
  await repo.updateAssistantMessage(current.id, {
    content: "Stopped.",
    proposals: [],
    status: "failed",
    runnerJob: null,
    runnerAgent: null,
  });
  await startNext(projectId);
}

/**
 * Answers the pending assistant message `messageId`. Never throws: a
 * failure becomes the message, so the person sees what went wrong.
 */
export async function answer(projectId: string, messageId: string, prompt?: string): Promise<void> {
  const repo = repository();
  try {
    const own = await repo.assistantMessage(messageId);
    const speaker = own?.speaker ?? "assistant";
    if (speaker !== "assistant") {
      await answerAsGuest(projectId, messageId, speaker);
      return;
    }
    const agent = await assistantAgentFor(projectId);
    if (agent.kind === "none") {
      await finish(messageId, {
        content: "No agent is set for the assistant. Pick or create one above.",
        status: "failed",
      });
      return;
    }
    if (agent.kind === "limited") {
      await finish(messageId, { content: agent.reason, status: "failed" });
      return;
    }

    const past = withPrompt(await historyBefore(projectId, messageId), prompt);
    const brief = agent.kind === "cli" ? agent.agent.brief : agent.brief;
    const system = await systemPrompt(projectId, brief);

    if (agent.kind === "cli") {
      await startCliAsk({
        projectId,
        messageId,
        agent: agent.agent,
        prompt: cliPrompt(system, past, await cliReports(projectId, past)),
      });
      return;
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

    const project = await projectFor(projectId);
    const creds = await credentialsForProject(project);
    const client = vcs(project.repoFullName, creds.repoToken);
    const proposals: AssistantProposal[] = [];
    const turnContext: TurnContext = {
      projectId,
      client,
      ref: project.baseBranch,
      branch: changeBranchFor(messageId),
      wrote: new Set(),
    };

    let results: Array<{ id: string; content: string; isError: boolean }> | null = null;
    const filesRead = new Set<string>();
    let lastError: string | null = null;
    let said = "";
    const startedAt = Date.now();
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (Date.now() - startedAt >= MAX_ANSWER_MS) {
        await finish(messageId, {
          content: outOfTimeReply(MAX_ANSWER_MS, [...filesRead], said),
          proposals,
          status: "done",
        });
        return;
      }
      const { text, calls } = await speak(results);
      if (text.trim()) said = text;
      if (calls.length === 0) {
        await finish(messageId, {
          content: text || (proposals.length ? "Here is what I propose." : "I have nothing to add."),
          proposals,
          status: "done",
        });
        return;
      }
      results = [];
      for (const call of calls) {
        const done = await runTool(call, turnContext, proposals);
        if (call.name === "read_file" && !done.isError) {
          const read = (call.input as { path?: unknown } | null)?.path;
          if (typeof read === "string") filesRead.add(read);
        }
        if (done.isError) lastError = done.content;
        results.push({ id: call.id, ...done });
      }
    }
    await finish(messageId, {
      content: outOfRoundsMessage([...filesRead], MAX_TURNS, lastError),
      proposals,
      status: "failed",
    });
  } catch (e) {
    await finish(messageId, {
      content: e instanceof Error ? e.message : String(e),
      status: "failed",
    });
  }
}

/** A column agent's prompt on a call: its column's instructions, the board, and who it is. */
async function guestPrompt(projectId: string, column: NonNullable<ReturnType<typeof columnOfSpeaker>>, speaker: string, brief: string | null): Promise<string> {
  const project = await projectFor(projectId);
  const system = await columnSystemPrompt(projectId, column, speaker as AgentRole, project.repoFullName, brief);
  return [
    system,
    "",
    "The board right now:",
    boardSnapshot(await repository().boardCards(projectId)),
    "",
    `You are ${guestLabel(speaker as GuestId)}. Answer the person's last message, briefly and plainly.`,
  ].join("\n");
}

/**
 * A column agent or a Sentinel answers: the column agent with the card actions
 * on its column's cards (a move to Done waits for approval), the Sentinel from
 * its latest audit, acting on nothing. An agent that is a CLI one speaks
 * through any API agent on the board instead, so a reply never waits on a job.
 */
async function answerAsGuest(projectId: string, messageId: string, speaker: string): Promise<void> {
  const column = columnOfSpeaker(speaker);
  const sentinelId = sentinelOfSpeaker(speaker);
  if (!column && !sentinelId) {
    await finish(messageId, { content: `${speaker} does not answer here.`, status: "failed" });
    return;
  }
  let agent = column ? await columnChatAgentFor(projectId, column) : await assistantAgentFor(projectId);
  // Its own instructions stay its own; only the voice it speaks through changes.
  const ownBrief = agent.kind === "cli" ? agent.agent.brief : agent.kind === "api" ? agent.brief : null;
  if (agent.kind !== "api" && agent.kind !== "limited") {
    const voice = await quickVoice(projectId);
    if (voice) agent = { ...voice, brief: ownBrief };
  }
  if (agent.kind === "none" || agent.kind === "limited") {
    await finish(messageId, {
      content: "reason" in agent ? agent.reason : "No agent is set for this. Pick or create one above.",
      status: "failed",
    });
    return;
  }
  if (agent.kind === "cli") {
    if (!column) {
      await finish(messageId, { content: "This agent runs in GitHub Actions, and no API agent is set to speak for it here.", status: "failed" });
      return;
    }
    // No API agent to speak for it: it answers itself, in GitHub Actions, like the PM.
    const system = await guestPrompt(projectId, column, speaker, agent.agent.brief);
    const past = await historyBefore(projectId, messageId);
    await startCliAsk({
      projectId,
      messageId,
      agent: agent.agent,
      prompt: cliPrompt(system, past, await cliReports(projectId, past)),
    });
    return;
  }

  const project = await projectFor(projectId);
  let system: string;
  let tools: ToolDef[] = [];
  if (column) {
    system = await columnSystemPrompt(projectId, column, speaker as AgentRole, project.repoFullName, agent.brief);
    tools = [...FILE_TOOL_DEFS, TOOL_DEFS.find((t) => t.name === "card_status")!, ACT_ON_CARD_DEF];
  } else {
    const prompt = await sentinelSystemPrompt(projectId, sentinelId!);
    if (!prompt) {
      await finish(messageId, {
        content: "I have not audited this board yet, so I have nothing to say about it. Summon me from Sentinels and ask again.",
        status: "done",
      });
      return;
    }
    system = prompt;
  }
  system = [
    system,
    "",
    "The board right now:",
    boardSnapshot(await repository().boardCards(projectId)),
    "",
    `You are ${guestLabel(speaker as GuestId)}. Answer the person's last message, briefly and plainly.`,
  ].join("\n");

  const past = await historyBefore(projectId, messageId);
  const { info } = agent;
  let speak: Speak;
  if (info.kind === "anthropic") {
    speak = claudeSpeak(agent.apiKey, agent.model ?? MODELS.product, system, past, tools);
  } else {
    if (!agent.apiKey) throw new Error(`This agent has no ${info.label} API key. Edit it and add one.`);
    if (!agent.model) throw new Error(`This agent has no ${info.label} model. Edit it and pick one.`);
    speak = openAiSpeak(info, agent.apiKey, agent.model, system, past, tools);
  }

  const client = vcs(project.repoFullName, (await credentialsForProject(project)).repoToken);
  const proposals: AssistantProposal[] = [];
  const done: string[] = [];
  const runTool = async (call: ToolCall) => {
    // Reading is not acting: a column agent may look at any card on the board.
    if (call.name === "card_status" && column) {
      try {
        const { key } = cardInput.parse(call.input);
        return { content: await cardReport(projectId, key, client), isError: false };
      } catch (e) {
        return { content: e instanceof Error ? e.message : String(e), isError: true };
      }
    }
    if (call.name === "act_on_card" && column) {
      try {
        const { key, action } = actOnCardInput.parse(call.input);
        const result = await actOnColumnCard(projectId, column, key, action, proposals);
        done.push(result);
        return { content: result, isError: false };
      } catch (e) {
        return { content: e instanceof Error ? e.message : String(e), isError: true };
      }
    }
    return runFileTool(call, client, project.baseBranch, async () => "There is no card chat here: use act_on_card.");
  };

  const ran = await runChatLoop({ speak, runTool, maxTurns: MAX_TURNS, budgetMs: MAX_ANSWER_MS });
  const actions = done.join("\n");
  if (ran.end === "answered") {
    await finish(messageId, { content: ran.text || actions || "I have nothing to add.", proposals, status: "done" });
  } else if (ran.end === "out_of_time") {
    await finish(messageId, {
      content: outOfTimeReply(MAX_ANSWER_MS, ran.read, actions),
      proposals,
      status: actions.trim() || proposals.length ? "done" : "failed",
    });
  } else {
    const closing = ran.text.trim() || actions;
    await finish(messageId, {
      content: outOfRoundsReply(MAX_TURNS, ran.read, closing),
      proposals,
      status: closing.trim() || proposals.length ? "done" : "failed",
    });
  }
}

/* ------------------------------------------------------------------------ */
/* A CLI agent answers in GitHub Actions, where it can read the checkout.    */
/* ------------------------------------------------------------------------ */

const cliAnswerSchema = z.object({
  reply: z.string(),
  proposals: z.array(z.object({ summary: z.string(), action: z.unknown() })).default([]),
  change: z.object({ title: z.string().trim().min(1).max(120), body: z.string() }).nullish(),
  answers: z.array(z.object({ key: z.string().min(1), answer: z.string().trim().min(1) })).default([]),
});

/**
 * A CLI agent cannot call card_status, so the live state of the cards the
 * person has been asking about is read for it before it starts.
 */
async function cliReports(projectId: string, past: Array<{ role: "user" | "assistant"; content: string }>): Promise<string> {
  const asked = past.filter((m) => m.role === "user").slice(-3).map((m) => m.content).join("\n");
  const cards = await repository().boardCards(projectId);
  const named = mentionedKeys(asked, cards).slice(0, MAX_CLI_REPORTS);
  // With no card named, the cards most likely being asked about: in review first, then blocked or misplaced.
  const inReview = cards.filter((c) => !c.archived && columnOf(c) === "in_review");
  const stuck = cards.filter((c) => !c.archived && columnOf(c) !== "in_review" && (c.blockedReason || c.misplacedReason));
  const keys = named.length
    ? named
    : [...inReview, ...stuck].slice(0, MAX_CLI_FALLBACK_REPORTS).map((c) => c.key);
  if (keys.length === 0) return "";
  const project = await projectFor(projectId);
  const creds = await credentialsForProject(project);
  const client = vcs(project.repoFullName, creds.repoToken);
  const reports = await Promise.all(keys.map((k) => cardReport(projectId, k, client).catch((e) => `${k}: could not read it (${e instanceof Error ? e.message : String(e)}).`)));
  const header = named.length
    ? "The live state of the cards the person asked about, read from the board and GitHub just now:"
    : "The person named no card. These are the cards in review or blocked, read from the board and GitHub just now:";
  return [header, "", ...reports.flatMap((r) => [r, ""])].join("\n");
}

function cliPrompt(
  system: string,
  past: Array<{ role: "user" | "assistant"; content: string }>,
  reports: string,
): string {
  return [
    system,
    "",
    "You are running in a checkout of the repository: read it directly.",
    ...(reports ? ["", reports] : []),
    "",
    "The conversation so far, oldest first. Answer the last message from the person.",
    "",
    ...past.map((m) => `### ${m.role === "user" ? "Person" : "You"}\n${m.content}\n`),
    "How to answer:",
    "- You may change the code. What you change in the checkout is kept on a branch of its own and offered to the person as a pull request, with the title and body you give in \"change\". Change files only when the person asked for a change or agreed to one. Install the project's dependencies if they are not there, and run its checks on your change before you finish. Changes under .github/workflows are not kept. Leave \"change\" out when you changed nothing.",
    "- Formic has read GitHub for you: the live state of the cards above is current. Answer about those cards from it, and never say you cannot see GitHub. For a card it does not cover, ask the person to name it.",
    "- You have no propose tool here. A proposal is an entry in the JSON below: describing one in your reply does nothing, and the person can only approve what is in the JSON.",
    "- Your final message is your answer, and it must be one JSON object and nothing else (you may write the same object to the file named by the FORMIC_OUTPUT environment variable instead). An answer that is not that JSON is thrown away:",
    '  {"reply": "<your answer, in Markdown>", "proposals": [{"summary": "<one line>", "action": <an action>}], "change": {"title": "<pull request title>", "body": "<what changed, why, and how you checked it>"}}',
    "- Your own change becomes its pull request through \"change\", not through an open_pull_request proposal.",
    "- To answer a question a card is waiting on yourself, because what the person already asked for settles it, add {\"key\": \"<card key>\", \"answer\": \"<your answer>\"} to \"answers\" in the JSON and say in your reply what you answered and why. The card's agent starts again with it. Leave answers out otherwise; a question only the person can settle goes in your reply, with your suggestion.",
    "- Leave proposals empty unless the person asked for a change to the board. When they agree to a ticket or ask for one (\"yes\", \"make it\", \"create the ticket\"), put it in proposals now: do not ask again, and do not re-explain. Each action matches this JSON Schema:",
    JSON.stringify(z.toJSONSchema(assistantActionSchema)),
  ].join("\n");
}

/** A CLI agent's answer arrived, or its run failed. */
/** Asks a CLI agent again, with what was wrong with its proposals. */
async function askAgain(
  projectId: string,
  messageId: string,
  previous: string,
  problems: string[],
  attempt: number,
): Promise<boolean> {
  const own = await repository().assistantMessage(messageId);
  const speaker = own?.speaker ?? "assistant";
  const column = speaker === "assistant" ? null : columnOfSpeaker(speaker);
  if (speaker !== "assistant" && !column) return false;
  const agent = column ? await columnChatAgentFor(projectId, column) : await assistantAgentFor(projectId);
  if (agent.kind !== "cli") return false;
  const { messages: all } = await repository().assistantMessages(projectId);
  const past = history(all.filter((m) => m.id !== messageId));
  const system = column
    ? await guestPrompt(projectId, column, speaker, agent.agent.brief)
    : await systemPrompt(projectId, agent.agent.brief);
  const prompt = [
    cliPrompt(system, past, await cliReports(projectId, past)),
    "",
    "You answered this already, but Formic could not use your proposals:",
    ...problems.map((p) => `- ${p}`),
    "",
    "Your previous answer:",
    previous.slice(0, 20_000),
    "",
    "Fix the proposals and write the whole answer again, in the same format.",
  ].join("\n");
  await startCliAsk({ projectId, messageId, agent: agent.agent, prompt, attempt });
  return true;
}

/** Tries a CLI agent gets to hand in proposals Formic can use: the owner's attempts limit. */
async function cliAnswerAttempts(projectId: string): Promise<number> {
  return attemptsFor((await projectFor(projectId)).ownerId, "cliAnswer");
}

export async function finishCliAnswer(
  messageId: string,
  answerText: string | null,
  failure?: string,
  /**
   * Where the answer came from, so a wrong proposal can be sent back once,
   * and the branch holding the code it changed, if it changed any. An
   * answer with a change is never sent back: a new run would start without it.
   */
  from?: { projectId: string; attempt: number; change?: string | null },
) {
  if (failure || !answerText?.trim()) {
    await finish(messageId, { content: failure ?? "The agent finished without an answer.", status: "failed" });
    return;
  }

  let raw: unknown = null;
  try {
    raw = extractJson(answerText);
  } catch {
    // Not JSON: the text is the reply.
  }
  const parsed = cliAnswerSchema.safeParse(raw);
  if (!parsed.success) {
    // Prose where the JSON answer was due: any proposal in it is lost, so
    // ask once more for the format before showing the text as it is.
    if (from && !from.change && from.attempt < (await cliAnswerAttempts(from.projectId))) {
      const again = await askAgain(
        from.projectId,
        messageId,
        answerText,
        ['Your answer was not the JSON object. Make your final message the JSON object {"reply": ..., "proposals": [...]} and nothing else. If the person asked for a ticket or agreed to one, it belongs in proposals.'],
        from.attempt + 1,
      ).then(
        () => true,
        () => false,
      );
      if (again) return;
    }
    await finish(messageId, {
      content: `${answerText.trim()}\n\n_The agent did not send its answer in a form Formic can read, so ${from?.change ? "only its code change" : "nothing here"} can be approved. If you asked for a ticket, ask again._`,
      proposals: from?.change ? [changeProposal(from.change, null, answerText)] : [],
      status: "done",
    });
    return;
  }

  const proposals: AssistantProposal[] = [];
  const dropped: string[] = [];
  for (const p of parsed.data.proposals) {
    const checked = checkAction(p.action);
    if (checked.ok) proposals.push({ summary: p.summary, action: checked.action, state: "proposed" });
    else dropped.push(`${p.summary}: ${checked.problem}`);
  }
  if (from?.change) proposals.unshift(changeProposal(from.change, parsed.data.change ?? null, parsed.data.reply));
  if (dropped.length && from && !from.change && from.attempt < (await cliAnswerAttempts(from.projectId))) {
    const again = await askAgain(from.projectId, messageId, answerText, dropped, from.attempt + 1).then(
      () => true,
      () => false,
    );
    if (again) return;
  }
  if (from) await passAnswers(from.projectId, parsed.data.answers);
  const note = dropped.length
    ? `\n\n_Formic set aside ${dropped.length === 1 ? "a proposal" : `${dropped.length} proposals`} it could not use: ${dropped.join("; ")}_`
    : "";
  await finish(messageId, { content: parsed.data.reply.trim() + note, proposals, status: "done" });
}

/** A CLI PM's own answers to the questions cards wait on. One the person answered first is left alone. */
async function passAnswers(projectId: string, answers: Array<{ key: string; answer: string }>): Promise<void> {
  if (answers.length === 0) return;
  const cards = await repository().boardCards(projectId);
  for (const a of answers) {
    const card = cards.find((c) => c.key.toLowerCase() === a.key.trim().toLowerCase());
    if (!card || !isQuestion(card.blockedReason)) continue;
    await askCardChat(projectId, card.kind, card.id, `${PM_ANSWER_PREFIX}${a.answer}`).catch(() => undefined);
  }
}

/** A CLI agent's code change, offered as the pull request it becomes on approval. */
function changeProposal(
  branch: string,
  change: { title: string; body: string } | null,
  reply: string,
): AssistantProposal {
  const title = change?.title ?? "Changes from the board's assistant";
  return {
    summary: `Open a pull request: ${title}`,
    action: {
      type: "open_pull_request",
      branch,
      title,
      body: (change?.body.trim() || reply.trim()).slice(0, 20_000) || title,
    },
    state: "proposed",
  };
}
