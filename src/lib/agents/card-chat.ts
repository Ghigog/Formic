import "server-only";

import { z } from "zod";

import { MODELS } from "./anthropic";
import { claudeSpeak, openAiSpeak, type Speak, type ToolDef } from "./chat-loop";
import { truncate } from "./coding-loop";
import { decomposeEpic, launch } from "./pipeline";
import { columnChatAgentFor } from "./presets";
import { addEpicNote } from "./epic-notes";
import { credentialsForProject } from "@/lib/auth/credentials";
import { projectFor } from "@/lib/board/project";
import { addNote } from "@/lib/coder/notes";
import { runCoderAgent } from "@/lib/coder/pipeline";
import { publish } from "@/lib/events/bus";
import { repository } from "@/lib/db";
import type { CardChatMessage } from "@/lib/db/repository";
import { COLUMN_AGENT_ROLE, AGENT_ROLE_LABELS, prdSchema } from "@/lib/domain/entities";
import { COLUMN_LABELS, columnFor } from "@/lib/domain/status";
import { vcs, type VcsClient } from "@/lib/vcs";

/**
 * One turn of a card's chat: the person tells the column's agent something
 * about this Epic or ticket. On a ticket, the message reaches any agent
 * working it, and every later run of it, as a note; a ticket idle in In
 * Progress is instead started fresh, with the note as its brief. On an Epic
 * already broken down, it goes to the Architect Agent to break down again,
 * replacing only the tickets no one has started. Anything else is answered
 * as a question, with the card's own detail and the repository to read for
 * context, but no way to change either.
 */

const MAX_TURNS = 10;
const MAX_FILES_LISTED = 400;

const listInput = z.object({ prefix: z.string().optional() });
const readInput = z.object({ path: z.string().min(1) });

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
];

async function cardContext(cardKind: "epic" | "ticket", cardId: string): Promise<string> {
  const repo = repository();
  if (cardKind === "epic") {
    const detail = await repo.epicDetail(cardId);
    if (!detail) return "(This Epic could not be loaded.)";
    return [
      `Epic: ${detail.title}`,
      "",
      "The person's original request:",
      detail.rawRequest,
      ...(detail.prd
        ? ["", "Its PRD, as JSON:", truncate(JSON.stringify(detail.prd, null, 2), 6_000)]
        : ["", "It has no PRD yet."]),
    ].join("\n");
  }
  const detail = await repo.ticketDetail(cardId);
  if (!detail) return "(This ticket could not be loaded.)";
  return [
    `Ticket ${detail.key}: ${detail.title}`,
    "",
    detail.description,
    ...(detail.acceptanceCriteria.length
      ? ["", "Acceptance criteria:", ...detail.acceptanceCriteria.map((c) => `- ${c}`)]
      : []),
    "",
    `File scope: ${detail.fileScope.join(", ") || "(none)"}`,
  ].join("\n");
}

async function systemPrompt(
  cardKind: "epic" | "ticket",
  cardId: string,
  columnLabel: string,
  roleLabel: string,
  repoFullName: string,
  brief: string | null,
): Promise<string> {
  return [
    `You are the ${roleLabel} Agent, answering questions about one ${cardKind === "epic" ? "Epic" : "ticket"} on a Formic board for the GitHub repository ${repoFullName}. It is in ${columnLabel} right now.`,
    "",
    "Read the repository before you answer a question about its code. Do not guess at what a file contains.",
    "",
    "You cannot change the board, the ticket lifecycle, or any file from here. If the person wants a change, tell them what to do (for example, edit the PRD, or drag the card) rather than claiming you did it.",
    "",
    "Answer in short, plain Markdown.",
    "",
    "The card:",
    await cardContext(cardKind, cardId),
    ...(brief ? ["", "The person's instructions for this agent:", brief] : []),
  ].join("\n");
}

function history(messages: CardChatMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  return messages
    .filter((m) => m.status === "done" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));
}

async function runTool(
  call: { name: string; input: unknown },
  client: VcsClient,
  ref: string,
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
    return { content: `There is no tool called ${call.name}.`, isError: true };
  } catch (e) {
    return { content: e instanceof Error ? e.message : String(e), isError: true };
  }
}

async function finish(
  messageId: string,
  update: { content: string; status: "done" | "failed" },
): Promise<void> {
  await repository().updateCardChatMessage(messageId, { content: update.content, status: update.status });
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
  const spoke = await reply(cardKind, cardId, messageId);
  if (cardKind === "ticket") await logReply(cardId, messageId, spoke);
}

/**
 * A ticket's chat shows in its log, beside the notes a person sends: the
 * answer goes there too, so one feed holds the whole conversation.
 */
async function logReply(ticketId: string, messageId: string, byAgent: boolean): Promise<void> {
  const repo = repository();
  const [message, card, projectId] = await Promise.all([
    repo.cardChatMessage(messageId),
    repo.cardById(ticketId),
    repo.projectOfCard(ticketId),
  ]);
  if (!message?.content.trim() || !card || !projectId) return;
  const role = COLUMN_AGENT_ROLE[columnFor(card.status, card.stalledIn)];
  await publish(projectId, {
    type: "ticket.reply",
    ticketId,
    agent: byAgent ? `${AGENT_ROLE_LABELS[role]} Agent` : null,
    text: message.content,
  });
}

/** Answers the message; true when the column's agent did, false for a notice. */
async function reply(
  cardKind: "epic" | "ticket",
  cardId: string,
  messageId: string,
): Promise<boolean> {
  const repo = repository();
  try {
    const card = await repo.cardById(cardId);
    const projectId = await repo.projectOfCard(cardId);
    if (!card || !projectId) {
      await finish(messageId, { content: "This card no longer exists.", status: "failed" });
      return false;
    }
    const column = columnFor(card.status, card.stalledIn);
    const role = COLUMN_AGENT_ROLE[column];
    const agent = await columnChatAgentFor(projectId, column);
    const hasAgent = agent.kind !== "none" && agent.kind !== "limited";

    // A ticket idle in In Progress has no run reading its notes right now:
    // the message is the instruction to pick the work back up, so it starts
    // one instead of waiting for someone to drag the card.
    if (cardKind === "ticket" && column === "in_progress" && hasAgent) {
      const detail = await repo.ticketDetail(cardId);
      const working = card.status === "running" || !!detail?.runnerJob || !!card.workingSince;
      if (!working) {
        launch(() => runCoderAgent(projectId, cardId), `coder agent for ${card.key}`);
        await finish(messageId, {
          content: "Starting the Coder Agent again with your note.",
          status: "done",
        });
        return false;
      }
    }

    // An Epic already broken down is the Architect Agent's to act on: the
    // message is an instruction to break it down again, not a question.
    // Tickets already in flight stay; applyTickets replaces only the rest.
    if (cardKind === "epic" && column === "todo" && hasAgent) {
      const detail = await repo.epicDetail(cardId);
      if (prdSchema.safeParse(detail?.prd).success) {
        const working = !!detail?.runnerJob || !!card.workingSince;
        if (working) {
          await finish(messageId, {
            content:
              "The Architect Agent is already working on this Epic. Your note will be included in its next run.",
            status: "done",
          });
        } else {
          launch(() => decomposeEpic(projectId, cardId), `architect agent for ${card.key}`);
          await finish(messageId, {
            content:
              "Breaking it down again with your note. Tickets already started stay; the rest follow it.",
            status: "done",
          });
        }
        return false;
      }
    }

    // A CLI agent has no live chat, but the agent working the ticket reads
    // the message between its steps and answers in the ticket's log, like a
    // note dropped into a running Claude Code session. Nothing to add here
    // while it works; when nothing is working it, say when it will be read.
    if (agent.kind === "cli" && cardKind === "ticket") {
      const detail = await repo.ticketDetail(cardId);
      const working = card.status === "running" || !!detail?.runnerJob || !!card.workingSince;
      await finish(messageId, {
        content: working
          ? ""
          : "Nothing is working this ticket right now. Its agent reads this when it next runs.",
        status: "done",
      });
      return false;
    }

    if (agent.kind === "none" || agent.kind === "limited" || agent.kind === "cli") {
      const reason =
        agent.kind === "cli"
          ? `${agent.info.label} runs in GitHub Actions and cannot reply here.`
          : agent.reason;
      await finish(
        messageId,
        cardKind === "ticket"
          ? { content: `${reason} Your message was passed on to the agent working this ticket.`, status: "done" }
          : { content: reason, status: "failed" },
      );
      return false;
    }

    const project = await projectFor(projectId);
    const all = await repo.cardChatMessages(cardId);
    const past = history(all.filter((m) => m.id !== messageId));
    const system = await systemPrompt(
      cardKind,
      cardId,
      COLUMN_LABELS[column],
      AGENT_ROLE_LABELS[role],
      project.repoFullName,
      agent.brief,
    );

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

    let results: Array<{ id: string; content: string; isError: boolean }> | null = null;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const { text, calls } = await speak(results);
      if (calls.length === 0) {
        await finish(messageId, { content: text || "I have nothing to add.", status: "done" });
        return true;
      }
      results = [];
      for (const call of calls) {
        results.push({ id: call.id, ...(await runTool(call, client, project.baseBranch)) });
      }
    }
    await finish(messageId, {
      content: "I read a lot and did not reach an answer. Try a narrower question.",
      status: "failed",
    });
  } catch (e) {
    await finish(messageId, { content: e instanceof Error ? e.message : String(e), status: "failed" });
  }
  return false;
}

export class ChatBusyError extends Error {
  constructor() {
    super("The agent is still answering the last message.");
  }
}

/**
 * Sends the person's message on a card's chat and starts the reply. On a
 * ticket it is also a note, so the agent working it, and every later run,
 * reads it even when the column's agent cannot reply live. On an Epic it is
 * kept the same way, for every later breakdown.
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
  const reply = await repo.addCardChatMessage({
    projectId,
    cardKind,
    cardId,
    role: "assistant",
    content: "",
    status: "pending",
  });
  launch(() => answer(cardKind, cardId, reply.id), `${cardKind} chat answer ${reply.id}`);
}
