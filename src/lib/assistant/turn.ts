import "server-only";

import { z } from "zod";

import { MODELS } from "@/lib/agents/anthropic";
import { claudeSpeak, openAiSpeak, type Speak, type ToolCall, type ToolDef } from "@/lib/agents/chat-loop";
import { CHAT_ANSWER_BUDGET_MS, outOfTimeReply } from "@/lib/agents/card-chat";
import { assistantAgentFor } from "@/lib/agents/presets";
import { credentialsForProject } from "@/lib/auth/credentials";
import { projectFor } from "@/lib/board/project";
import { attemptsFor } from "@/lib/budget/in-process";
import { repository } from "@/lib/db";
import type { AssistantMessage, AssistantProposal } from "@/lib/db/repository";
import { extractJson } from "@/lib/llm/openai-compat";
import { startCliAsk } from "@/lib/runner/runner";
import { vcs, type VcsClient } from "@/lib/vcs";
import { ASSISTANT_BRANCH_PREFIX, assistantActionSchema, checkAction } from "./actions";
import { boardSnapshot, cardReport, mentionedKeys } from "./context";
import { outOfRoundsMessage, readWindow } from "./reads";
import { ENGINEERING_PRACTICES, TICKET_TEMPLATE } from "@/lib/agents/prompts";

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

/** The branch one answer's code change goes on: by its message, or its job's nonce for a CLI agent. */
export function changeBranchFor(id: string): string {
  return `${ASSISTANT_BRANCH_PREFIX}${id.replace(/[^A-Za-z0-9-]/g, "").slice(-16)}`;
}

/** How many cards' live state a CLI agent is handed up front. */
const MAX_CLI_REPORTS = 4;

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

export async function systemPrompt(projectId: string, brief: string | null): Promise<string> {
  const project = await projectFor(projectId);
  return [
    `You are the assistant on a Formic board for the GitHub repository ${project.repoFullName} (base branch ${project.baseBranch}). The person can ask you anything about the repository and the work on the board.`,
    "",
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
    ENGINEERING_PRACTICES,
    "",
    `You have ${MAX_TURNS} rounds, one per model call, and an answer that runs out of them is lost. Call propose as soon as you know the ticket list; do not read further to polish it. A thin fileScope is better than no proposal.`,
    "",
    "Answer in short, plain Markdown. After proposing, say in one line what you proposed.",
    "",
    "The board right now:",
    boardSnapshot(await repository().boardCards(projectId)),
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
}

/** The person stopped waiting: pending answers become failed, so a new question is accepted. */
export async function cancelPending(projectId: string): Promise<void> {
  const repo = repository();
  for (const m of await repo.assistantMessages(projectId)) {
    if (m.status !== "pending") continue;
    await repo.updateAssistantMessage(m.id, {
      content: "Stopped.",
      proposals: [],
      status: "failed",
      runnerJob: null,
      runnerAgent: null,
    });
  }
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
    const client = vcs(project.repoFullName, creds.githubToken);
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

/* ------------------------------------------------------------------------ */
/* A CLI agent answers in GitHub Actions, where it can read the checkout.    */
/* ------------------------------------------------------------------------ */

const cliAnswerSchema = z.object({
  reply: z.string(),
  proposals: z.array(z.object({ summary: z.string(), action: z.unknown() })).default([]),
  change: z.object({ title: z.string().trim().min(1).max(120), body: z.string() }).nullish(),
});

/**
 * A CLI agent cannot call card_status, so the live state of the cards the
 * person has been asking about is read for it before it starts.
 */
async function cliReports(projectId: string, past: Array<{ role: "user" | "assistant"; content: string }>): Promise<string> {
  const asked = past.filter((m) => m.role === "user").slice(-3).map((m) => m.content).join("\n");
  const keys = mentionedKeys(asked, await repository().boardCards(projectId)).slice(0, MAX_CLI_REPORTS);
  if (keys.length === 0) return "";
  const project = await projectFor(projectId);
  const creds = await credentialsForProject(project);
  const client = vcs(project.repoFullName, creds.githubToken);
  const reports = await Promise.all(keys.map((k) => cardReport(projectId, k, client).catch((e) => `${k}: could not read it (${e instanceof Error ? e.message : String(e)}).`)));
  return ["The live state of the cards the person asked about, read from the board and GitHub just now:", "", ...reports.flatMap((r) => [r, ""])].join("\n");
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
    "- You have no card_status tool here: the live state above is what Formic read for you. A card it does not cover, ask the person to name.",
    "- You have no propose tool here. A proposal is an entry in the JSON below: describing one in your reply does nothing, and the person can only approve what is in the JSON.",
    "- Your final message is your answer, and it must be one JSON object and nothing else (you may write the same object to the file named by the FORMIC_OUTPUT environment variable instead). An answer that is not that JSON is thrown away:",
    '  {"reply": "<your answer, in Markdown>", "proposals": [{"summary": "<one line>", "action": <an action>}], "change": {"title": "<pull request title>", "body": "<what changed, why, and how you checked it>"}}',
    "- Your own change becomes its pull request through \"change\", not through an open_pull_request proposal.",
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
  const agent = await assistantAgentFor(projectId);
  if (agent.kind !== "cli") return false;
  const all = await repository().assistantMessages(projectId);
  const past = history(all.filter((m) => m.id !== messageId));
  const system = await systemPrompt(projectId, agent.agent.brief);
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
  const note = dropped.length
    ? `\n\n_Formic set aside ${dropped.length === 1 ? "a proposal" : `${dropped.length} proposals`} it could not use: ${dropped.join("; ")}_`
    : "";
  await finish(messageId, { content: parsed.data.reply.trim() + note, proposals, status: "done" });
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
