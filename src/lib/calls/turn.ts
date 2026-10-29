import "server-only";

import { z } from "zod";

import { MODELS } from "@/lib/agents/anthropic";
import { applyCardAction, cardActionSchema, CARD_ACTIONS_GUIDE } from "@/lib/agents/card-actions";
import {
  CHAT_ANSWER_BUDGET_MS,
  FILE_TOOL_DEFS,
  outOfRoundsReply,
  outOfTimeReply,
  runTool as runFileTool,
} from "@/lib/agents/card-chat";
import { claudeSpeak, openAiSpeak, runChatLoop, type Speak, type ToolCall, type ToolDef } from "@/lib/agents/chat-loop";
import { launch } from "@/lib/agents/pipeline";
import { assistantAgentFor, columnChatAgentFor } from "@/lib/agents/presets";
import { checkAction, assistantActionSchema } from "@/lib/assistant/actions";
import { boardSnapshot } from "@/lib/assistant/context";
import {
  changeBranchFor,
  runTool as runAssistantTool,
  systemPrompt as assistantSystemPrompt,
  TOOL_DEFS as ASSISTANT_TOOL_DEFS,
  type TurnContext,
} from "@/lib/assistant/turn";
import { credentialsForProject } from "@/lib/auth/credentials";
import { projectFor } from "@/lib/board/project";
import { repository } from "@/lib/db";
import type { AssistantProposal, CallMessage, Meeting } from "@/lib/db/repository";
import { AGENT_ROLE_LABELS, COLUMN_AGENT_ROLE, type AgentRole } from "@/lib/domain/entities";
import { COLUMN_LABELS, columnOf, type ColumnId } from "@/lib/domain/status";
import { extractJson } from "@/lib/llm/openai-compat";
import { sentinel as findSentinel } from "@/lib/sentinels/roster";
import { sentinelsFor } from "@/lib/sentinels/service";
import { vcs } from "@/lib/vcs";
import { COLUMN_AGENT_GUESTS, guestLabel, type GuestId } from "./guests";
import { callContext, detectAddGuest, resolveAddressee } from "./routing";

/**
 * One turn of a call: the person says something, and the guest it is for
 * answers with the powers it has everywhere else. The assistant reads the
 * repository and proposes changes that wait for approval; a column agent acts
 * on the cards in its own column with its card-chat actions; a Sentinel talks
 * from its latest audit and starts none.
 *
 * A guest that takes longer than CALL_REPLY_BUDGET_MS (or a CLI agent, which
 * answers from GitHub Actions) says it will get back; its real answer
 * replaces that line in the same message when it is ready.
 */

/** How long a guest may take before it says it will get back to the person. */
export const CALL_REPLY_BUDGET_MS = 30_000;
export const GET_BACK = "I'll get back to you.";

const MAX_TURNS = 12;

/** The column an agent guest works: the inverse of COLUMN_AGENT_ROLE. */
function columnOfGuest(guest: GuestId): ColumnId | null {
  if (!(COLUMN_AGENT_GUESTS as readonly string[]).includes(guest)) return null;
  const found = Object.entries(COLUMN_AGENT_ROLE).find(([, role]) => role === guest);
  return found ? (found[0] as ColumnId) : null;
}

/** Who is on the call: the assistant, a meeting's guests and anyone who has spoken. */
function guestsOf(meeting: Meeting | null, messages: readonly CallMessage[]): GuestId[] {
  const spoke = messages.flatMap((m) => (m.guestId ? [m.guestId] : []));
  return [...new Set<GuestId>(["assistant", ...(meeting?.guests ?? []), ...spoke])];
}

/* ------------------------------------------------------------------------ */
/* Sending.                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Sends the person's message in a call (`meetingId` null for an unscheduled
 * one) and starts the reply. A message that asks to bring a guest in adds
 * them, and they answer it if it names nobody else.
 */
export async function ask(projectId: string, meetingId: string | null, text: string): Promise<void> {
  const repo = repository();
  const meeting = meetingId ? ((await repo.meetings(projectId)).find((m) => m.id === meetingId) ?? null) : null;
  if (meetingId && !meeting) throw new Error("This meeting no longer exists.");
  const guests = guestsOf(meeting, await repo.callMessages(projectId, meetingId));

  const added = detectAddGuest(text);
  const joining = added && !guests.includes(added) ? added : null;
  if (joining) {
    guests.push(joining);
    if (meeting) await repo.updateMeeting(meeting.id, { guests: [...meeting.guests, joining] });
  }
  const named = resolveAddressee(text, guests);
  const addressee = named === "assistant" && joining ? joining : named;

  await repo.addCallMessage({ projectId, meetingId, role: "user", content: text });
  const pending = await repo.addCallMessage({
    projectId,
    meetingId,
    role: "assistant",
    guestId: addressee,
    content: "",
    status: "pending",
  });
  launch(() => answer(pending.id), `call answer ${pending.id}`);
}

/**
 * Answers the pending call message `messageId`. Never throws: a failure
 * becomes the message. A guest still working when the budget passes says it
 * will get back, and the same message holds its answer once it is ready.
 */
export async function answer(messageId: string, budgetMs = CALL_REPLY_BUDGET_MS): Promise<void> {
  const repo = repository();
  const work = reply(messageId).catch((e) =>
    settle(messageId, { content: e instanceof Error ? e.message : String(e), status: "failed" }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<"slow">((resolve) => {
    timer = setTimeout(() => resolve("slow"), budgetMs);
  });
  const first = await Promise.race([work.then(() => "done" as const), slow]);
  clearTimeout(timer);
  if (first === "slow") {
    const current = await repo.callMessage(messageId);
    if (current?.status === "pending" && !current.content) {
      await repo.updateCallMessage(messageId, { content: GET_BACK });
    }
    await work;
  }
}

async function settle(
  messageId: string,
  update: { content: string; status: "done" | "failed"; proposals?: AssistantProposal[] },
): Promise<void> {
  await repository().updateCallMessage(messageId, { proposals: [], ...update, runnerJob: null });
}

/* ------------------------------------------------------------------------ */
/* What each guest can do.                                                   */
/* ------------------------------------------------------------------------ */

const actOnCardInput = z.object({ key: z.string().min(1), action: z.unknown() });

const ACT_ON_CARD_DEF: ToolDef = {
  name: "act_on_card",
  description:
    "Do something to one card in your column, by its key: move, close, redo, stop, edit_ticket or needs_human. It happens at once, and the result says what happened. Cards in other columns are not yours to act on.",
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

/** Carries out an action on a card of this column, as its card chat would; says what happened. */
async function actOnColumnCard(projectId: string, column: ColumnId, key: string, raw: unknown): Promise<string> {
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
  return applyCardAction(projectId, card.kind, card.id, action.data);
}

/** A column agent's instructions for a call, with the cards it can act on. */
async function columnSystemPrompt(
  projectId: string,
  column: ColumnId,
  role: AgentRole,
  repoFullName: string,
  brief: string | null,
): Promise<string> {
  const cards = (await repository().boardCards(projectId)).filter((c) => columnOf(c) === column);
  return [
    `You are the ${AGENT_ROLE_LABELS[role]} Agent: the agent the person set for the ${COLUMN_LABELS[column]} column of a Formic board for the GitHub repository ${repoFullName}. You are a guest in a call with the person. The cards in ${COLUMN_LABELS[column]} are yours; you act on no others.`,
    ...(brief ? ["", "Your instructions for this column's work:", brief.trim()] : []),
    "",
    "Read the repository before you answer a question about its code. Do not guess at what a file contains.",
    "",
    CARD_ACTIONS_GUIDE.replace("this column's work on the card", "this column's work on the card named"),
    "Name the card you act on by its key in act_on_card.",
    "",
    `The cards in ${COLUMN_LABELS[column]} now:`,
    ...(cards.length
      ? cards.map(
          (c) => `- ${c.key} [${c.status}] ${c.title}${c.blockedReason ? ` (${c.blockedReason})` : ""}`,
        )
      : ["(none)"]),
  ].join("\n");
}

/** A Sentinel's persona and its latest audit: what it talks from, with no tools. */
async function sentinelSystemPrompt(projectId: string, sentinelId: string): Promise<string | null> {
  const s = findSentinel(sentinelId);
  const state = (await sentinelsFor(projectId))[sentinelId];
  if (!s || !state?.report) return null;
  const points = (label: string, list: Array<{ text: string; ref: string | null }>) =>
    list.length ? [`${label}:`, ...list.map((p) => `- ${p.text}${p.ref ? ` (${p.ref})` : ""}`)] : [];
  return [
    s.persona,
    "",
    `You are a guest in a call with the person. Answer only from your latest audit of this board, below. You cannot audit again from here: when something is not in it, say so and that a new audit would tell.${state.auditStale ? " Work has shipped since this audit, so say that it may be out of date." : ""}`,
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

/* ------------------------------------------------------------------------ */
/* Answering.                                                                */
/* ------------------------------------------------------------------------ */

const SENTINEL_PREFIX = "sentinel:";

async function reply(messageId: string): Promise<void> {
  const repo = repository();
  const message = await repo.callMessage(messageId);
  if (!message || message.status !== "pending") return;
  const { projectId, meetingId } = message;
  const guest = message.guestId ?? "assistant";

  const meeting = meetingId ? ((await repo.meetings(projectId)).find((m) => m.id === meetingId) ?? null) : null;
  const all = await repo.callMessages(projectId, meetingId);
  const asked = all.filter((m) => m.role === "user").at(-1)?.content ?? "";
  const said = all.filter((m) => m.id !== messageId && m.status === "done" && m.content.trim());
  const cards = await repo.boardCards(projectId);
  const context = callContext(meeting, boardSnapshot(cards), said);

  const column = columnOfGuest(guest);
  const sentinelId = guest.startsWith(SENTINEL_PREFIX) ? guest.slice(SENTINEL_PREFIX.length) : null;
  const project = await projectFor(projectId);

  // Who answers, and with what instructions and tools.
  let system: string;
  let tools: ToolDef[] = [];
  let agent: Awaited<ReturnType<typeof assistantAgentFor>> | Awaited<ReturnType<typeof columnChatAgentFor>>;
  if (column) {
    agent = await columnChatAgentFor(projectId, column);
  } else {
    agent = await assistantAgentFor(projectId);
  }
  if (agent.kind === "none" || agent.kind === "limited") {
    await settle(messageId, {
      content: "reason" in agent ? agent.reason : "No agent is set for the assistant. Pick or create one above.",
      status: "failed",
    });
    return;
  }
  const brief = agent.kind === "cli" ? agent.agent.brief : agent.brief;
  if (column) {
    system = await columnSystemPrompt(projectId, column, guest as AgentRole, project.repoFullName, brief);
    tools = [...FILE_TOOL_DEFS, ACT_ON_CARD_DEF];
  } else if (sentinelId) {
    const prompt = await sentinelSystemPrompt(projectId, sentinelId);
    if (!prompt) {
      await settle(messageId, {
        content: `I have not audited this board yet, so I have nothing to say about it. Summon me from Sentinels and ask again.`,
        status: "done",
      });
      return;
    }
    system = prompt;
  } else {
    system = await assistantSystemPrompt(projectId, brief);
    tools = ASSISTANT_TOOL_DEFS;
  }
  system = [system, "", context, "", `You are ${guestLabel(guest)}. Answer the person's last message.`].join("\n");

  if (agent.kind === "cli") {
    const { startCliCallAnswer } = await import("@/lib/runner/runner");
    const failure = await startCliCallAnswer({
      projectId,
      messageId,
      agent: agent.agent,
      prompt: cliCallPrompt(system, asked, guest),
    });
    // The answer lands from GitHub Actions, in a minute or two.
    if (failure) await settle(messageId, { content: failure, status: "failed" });
    else await repo.updateCallMessage(messageId, { content: GET_BACK });
    return;
  }

  const past = [{ role: "user" as const, content: asked }];
  const { info } = agent;
  let speak: Speak;
  if (info.kind === "anthropic") {
    speak = claudeSpeak(agent.apiKey, agent.model ?? MODELS.product, system, past, tools);
  } else {
    if (!agent.apiKey) throw new Error(`This agent has no ${info.label} API key. Edit it and add one.`);
    if (!agent.model) throw new Error(`This agent has no ${info.label} model. Edit it and pick one.`);
    speak = openAiSpeak(info, agent.apiKey, agent.model, system, past, tools);
  }

  const creds = await credentialsForProject(project);
  const client = vcs(project.repoFullName, creds.githubToken);
  const proposals: AssistantProposal[] = [];
  const done: string[] = [];
  const turnContext: TurnContext = {
    projectId,
    client,
    ref: project.baseBranch,
    branch: changeBranchFor(messageId),
    wrote: new Set(),
  };
  const runTool = async (call: ToolCall) => {
    if (column && call.name === "act_on_card") {
      try {
        const { key, action } = actOnCardInput.parse(call.input);
        const result = await actOnColumnCard(projectId, column, key, action);
        done.push(result);
        return { content: result, isError: false };
      } catch (e) {
        return { content: e instanceof Error ? e.message : String(e), isError: true };
      }
    }
    return column
      ? runFileTool(call, client, project.baseBranch, async () => "There is no card chat here: use act_on_card.")
      : runAssistantTool(call, turnContext, proposals);
  };

  const ran = await runChatLoop({ speak, runTool, maxTurns: MAX_TURNS, budgetMs: CHAT_ANSWER_BUDGET_MS });
  const actions = done.join("\n");
  if (ran.end === "answered") {
    await settle(messageId, {
      content: ran.text || actions || (proposals.length ? "Here is what I propose." : "I have nothing to add."),
      status: "done",
      proposals,
    });
  } else if (ran.end === "out_of_time") {
    await settle(messageId, {
      content: outOfTimeReply(CHAT_ANSWER_BUDGET_MS, ran.read, actions),
      status: actions.trim() || proposals.length ? "done" : "failed",
      proposals,
    });
  } else {
    const closing = ran.text.trim() || actions;
    await settle(messageId, {
      content: outOfRoundsReply(MAX_TURNS, ran.read, closing),
      status: closing.trim() || proposals.length ? "done" : "failed",
      proposals,
    });
  }
}

/* ------------------------------------------------------------------------ */
/* A CLI agent answers in GitHub Actions.                                    */
/* ------------------------------------------------------------------------ */

const cliAnswerSchema = z.object({
  reply: z.string(),
  actions: z.array(z.object({ key: z.string(), action: z.unknown() })).default([]),
  proposals: z.array(z.object({ summary: z.string(), action: z.unknown() })).default([]),
});

function cliCallPrompt(system: string, asked: string, guest: GuestId): string {
  const column = columnOfGuest(guest);
  return [
    system,
    "",
    "You are running in a checkout of the repository: read it directly. Do not change, create or delete any file; nothing you change is kept.",
    "",
    `The person said: ${asked}`,
    "",
    "Your final message is your answer, and it must be one JSON object and nothing else (you may write it to the file named by the FORMIC_OUTPUT environment variable instead):",
    '  {"reply": "<your answer, in Markdown>", "actions": [{"key": "<card key>", "action": <an action>}], "proposals": [{"summary": "<one line>", "action": <an action>}]}',
    ...(column
      ? [
          "- actions carry out at once, on cards in your column only. Leave it empty unless the person asked for something to be done. Each action matches this JSON Schema:",
          JSON.stringify(z.toJSONSchema(cardActionSchema)),
          "- Leave proposals empty.",
        ]
      : guest === "assistant"
        ? [
            "- Leave actions empty. A proposal waits for the person's approval; leave proposals empty unless they asked for a change to the board. Each action matches this JSON Schema:",
            JSON.stringify(z.toJSONSchema(assistantActionSchema)),
          ]
        : ["- Leave actions and proposals empty."]),
  ].join("\n");
}

/**
 * A CLI agent's answer to a call message arrived, or its run failed: carries
 * out what a column agent decided, keeps what the assistant proposed, and
 * puts its reply where the "I'll get back to you" was.
 */
export async function finishCliCall(messageId: string, answerText: string | null, failure?: string): Promise<void> {
  const repo = repository();
  const message = await repo.callMessage(messageId);
  if (!message || message.status !== "pending") return;
  if (failure || !answerText?.trim()) {
    await settle(messageId, { content: failure ?? "The agent finished without an answer.", status: "failed" });
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
    await settle(messageId, { content: answerText.trim(), status: "done" });
    return;
  }
  const guest = message.guestId ?? "assistant";
  const column = columnOfGuest(guest);
  const lines: string[] = [];
  if (column) {
    for (const a of parsed.data.actions) {
      lines.push(await actOnColumnCard(message.projectId, column, a.key, a.action));
    }
  }
  const proposals: AssistantProposal[] = [];
  if (guest === "assistant") {
    for (const p of parsed.data.proposals) {
      const checked = checkAction(p.action);
      if (checked.ok) proposals.push({ summary: p.summary, action: checked.action, state: "proposed" });
      else lines.push(`_Formic set aside a proposal it could not use: ${p.summary}: ${checked.problem}_`);
    }
  }
  await settle(messageId, {
    content: [parsed.data.reply.trim(), ...lines].filter(Boolean).join("\n\n") || "I have nothing to add.",
    status: "done",
    proposals,
  });
}
