import "server-only";

import { z } from "zod";

import { MODELS } from "./anthropic";
import { claudeSpeak, openAiSpeak, type Speak, type ToolDef } from "./chat-loop";
import { truncate } from "./coding-loop";
import { launch } from "./pipeline";
import { columnChatAgentFor } from "./presets";
import { credentialsForProject } from "@/lib/auth/credentials";
import { projectFor } from "@/lib/board/project";
import { addNote } from "@/lib/coder/notes";
import { repository } from "@/lib/db";
import type { CardChatMessage } from "@/lib/db/repository";
import { COLUMN_AGENT_ROLE, AGENT_ROLE_LABELS } from "@/lib/domain/entities";
import { COLUMN_LABELS, columnFor } from "@/lib/domain/status";
import { vcs, type VcsClient } from "@/lib/vcs";

/**
 * One turn of a card's chat: the person tells the column's agent something
 * about this Epic or ticket, and it answers with the card's own detail as
 * context. On a ticket, the message also reaches any agent working it, and
 * every later run of it, as a note. The chat can read the repository, but
 * it cannot change the board or the ticket lifecycle.
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
  const repo = repository();
  try {
    const card = await repo.cardById(cardId);
    const projectId = await repo.projectOfCard(cardId);
    if (!card || !projectId) {
      await finish(messageId, { content: "This card no longer exists.", status: "failed" });
      return;
    }
    const column = columnFor(card.status, card.stalledIn);
    const role = COLUMN_AGENT_ROLE[column];
    const agent = await columnChatAgentFor(projectId, column);

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
      return;
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
        return;
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
}

export class ChatBusyError extends Error {
  constructor() {
    super("The agent is still answering the last message.");
  }
}

/**
 * Sends the person's message on a card's chat and starts the reply. On a
 * ticket it is also a note, so the agent working it, and every later run,
 * reads it even when the column's agent cannot reply live.
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
