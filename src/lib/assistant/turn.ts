import "server-only";

import { z } from "zod";

import { MODELS } from "@/lib/agents/anthropic";
import { claudeSpeak, openAiSpeak, type Speak, type ToolCall, type ToolDef } from "@/lib/agents/chat-loop";
import { assistantAgentFor } from "@/lib/agents/presets";
import { credentialsForProject } from "@/lib/auth/credentials";
import { projectFor } from "@/lib/board/project";
import { truncate } from "@/lib/agents/coding-loop";
import { repository } from "@/lib/db";
import type { AssistantMessage, AssistantProposal } from "@/lib/db/repository";
import type { BoardCard } from "@/lib/domain/entities";
import { COLUMN_LABELS, columnFor } from "@/lib/domain/status";
import { extractJson } from "@/lib/llm/openai-compat";
import { startCliAsk } from "@/lib/runner/runner";
import { vcs, type VcsClient } from "@/lib/vcs";
import { assistantActionSchema, checkAction } from "./actions";
import { ENGINEERING_PRACTICES, TICKET_TEMPLATE } from "@/lib/agents/prompts";

/**
 * One turn of the board's assistant: the person asked something, the agent
 * they picked answers it.
 *
 * It can read the repository and the board, and it can propose changes to
 * the board, which wait for the person's approval. It cannot change code:
 * code changes are tickets, and tickets go through the file-scope checks,
 * pull requests and CI like everything else.
 */

const MAX_TURNS = 16;
const MAX_FILES_LISTED = 400;

const listInput = z.object({ prefix: z.string().optional() });
const readInput = z.object({ path: z.string().min(1) });
const proposeInput = z.object({ summary: z.string().min(1), action: z.unknown() });

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

async function boardSnapshot(projectId: string): Promise<string> {
  const cards = await repository().boardCards(projectId);
  if (cards.length === 0) return "(The board is empty.)";
  const byId = new Map(cards.map((c) => [c.id, c]));
  const where = (c: BoardCard) => `${COLUMN_LABELS[columnFor(c.status, c.stalledIn)]} · ${c.status}`;
  const ticketLine = (c: BoardCard) => {
    const deps = c.dependsOn.map((id) => byId.get(id)?.key).filter(Boolean);
    return `  - ${c.key} [${where(c)}] ${c.title} (scope: ${c.fileScope.join(", ") || "none"}${
      deps.length ? `; after ${deps.join(", ")}` : ""
    }${c.prNumber ? `; PR #${c.prNumber}` : ""})`;
  };
  const lines: string[] = [];
  for (const epic of cards.filter((c) => c.kind === "epic")) {
    lines.push(`- Epic ${epic.key} [${where(epic)}] ${epic.title}`);
    for (const t of cards.filter((c) => c.kind === "ticket" && c.epicId === epic.id)) lines.push(ticketLine(t));
  }
  const orphans = cards.filter((c) => c.kind === "ticket" && !byId.has(c.epicId ?? ""));
  if (orphans.length) lines.push("- Tickets without an Epic", ...orphans.map(ticketLine));
  return truncate(lines.join("\n"), 12_000);
}

export async function systemPrompt(projectId: string, brief: string | null): Promise<string> {
  const project = await projectFor(projectId);
  return [
    `You are the assistant on a Formic board for the GitHub repository ${project.repoFullName} (base branch ${project.baseBranch}). The person can ask you anything about the repository and the work on the board.`,
    "",
    "Read the repository before you answer a question about its code. Do not guess at what a file contains.",
    "",
    "You cannot change code or files. You can propose changes to the board, and each one happens only if the person approves it:",
    "- create_epic_with_tickets, for work that is already planned into tickets (a ticket list in the repository, a plan you agreed on). It lands in To Do.",
    "- create_backlog_item, for a request that still needs a PRD. The Product Agent writes one.",
    "A ticket's fileScope lists the directories it may change, as prefixes from the repository root: 1 to 12 entries, so name directories such as \"src/renderer\" rather than every file in them. Tickets that could run at the same time must not share a scope: make one depend on the other instead. Keys are short and stable, such as \"T-1\".",
    "",
    TICKET_TEMPLATE,
    "",
    ENGINEERING_PRACTICES,
    "",
    "Answer in short, plain Markdown. After proposing, say in one line what you proposed.",
    "",
    "The board right now:",
    await boardSnapshot(projectId),
    ...(brief ? ["", "The person's instructions for you:", brief] : []),
  ].join("\n");
}

/** Earlier messages as plain text, the way every provider accepts them. */
function history(messages: AssistantMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  return messages
    .filter((m) => m.status === "done" && m.content.trim())
    .map((m) => ({
      role: m.role,
      content: [
        m.content,
        ...m.proposals.map((p) => `[Proposed: ${p.summary}. The person ${p.state === "proposed" ? "has not decided yet" : p.state === "applied" ? "approved it" : p.state === "dismissed" ? "dismissed it" : "approved it, but it failed"}.]`),
      ].join("\n"),
    }));
}

async function runTool(
  call: ToolCall,
  client: VcsClient,
  ref: string,
  proposals: AssistantProposal[],
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
  await repository().updateAssistantMessage(messageId, {
    content: update.content,
    proposals: update.proposals ?? [],
    status: update.status,
    runnerJob: null,
  });
}

/**
 * Answers the pending assistant message `messageId`. Never throws: a
 * failure becomes the message, so the person sees what went wrong.
 */
export async function answer(projectId: string, messageId: string): Promise<void> {
  const repo = repository();
  try {
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

    const all = await repo.assistantMessages(projectId);
    const past = history(all.filter((m) => m.id !== messageId));
    const brief = agent.kind === "cli" ? agent.agent.brief : agent.brief;
    const system = await systemPrompt(projectId, brief);

    if (agent.kind === "cli") {
      await startCliAsk({ projectId, messageId, agent: agent.agent, prompt: cliPrompt(system, past) });
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
    const client = vcs(project.repoFullName, creds.githubToken);
    const proposals: AssistantProposal[] = [];

    let results: Array<{ id: string; content: string; isError: boolean }> | null = null;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const { text, calls } = await speak(results);
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
        results.push({ id: call.id, ...(await runTool(call, client, project.baseBranch, proposals)) });
      }
    }
    await finish(messageId, {
      content: "I read a lot and did not reach an answer. Try a narrower question.",
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

/* ------------------------------------------------------------------------ */
/* A CLI agent answers in GitHub Actions, where it can read the checkout.    */
/* ------------------------------------------------------------------------ */

const cliAnswerSchema = z.object({
  reply: z.string(),
  proposals: z.array(z.object({ summary: z.string(), action: z.unknown() })).default([]),
});

function cliPrompt(system: string, past: Array<{ role: "user" | "assistant"; content: string }>): string {
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
    '  {"reply": "<your answer, in Markdown>", "proposals": [{"summary": "<one line>", "action": <an action>}]}',
    "- Leave proposals empty unless the person asked for a change to the board. Each action matches this JSON Schema:",
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
  const agent = await assistantAgentFor(projectId);
  if (agent.kind !== "cli") return false;
  const all = await repository().assistantMessages(projectId);
  const past = history(all.filter((m) => m.id !== messageId));
  const system = await systemPrompt(projectId, agent.agent.brief);
  const prompt = [
    cliPrompt(system, past),
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

/** Tries a CLI agent gets to hand in proposals Formic can use. */
const CLI_ANSWER_ATTEMPTS = 2;

export async function finishCliAnswer(
  messageId: string,
  answerText: string | null,
  failure?: string,
  /** Where the answer came from, so a wrong proposal can be sent back once. */
  from?: { projectId: string; attempt: number },
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
    await finish(messageId, { content: answerText.trim(), status: "done" });
    return;
  }

  const proposals: AssistantProposal[] = [];
  const dropped: string[] = [];
  for (const p of parsed.data.proposals) {
    const checked = checkAction(p.action);
    if (checked.ok) proposals.push({ summary: p.summary, action: checked.action, state: "proposed" });
    else dropped.push(`${p.summary}: ${checked.problem}`);
  }
  if (dropped.length && from && from.attempt < CLI_ANSWER_ATTEMPTS) {
    const again = await askAgain(from.projectId, messageId, answerText, dropped, from.attempt + 1).then(
      () => true,
      () => false,
    );
    if (again) return;
  }
  const note = dropped.length
    ? `\n\n_Formic set aside ${dropped.length === 1 ? "a proposal" : `${dropped.length} proposals`} it could not use: ${dropped.join("; ")}_`
    : "";
  await finish(messageId, { content: parsed.data.reply.trim() + note, proposals, status: "done" });
}
