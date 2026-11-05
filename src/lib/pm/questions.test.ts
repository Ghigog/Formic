import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { wakePm, questionPrompt } from "./questions";
import { finishCliAnswer } from "@/lib/assistant/turn";
import { epicNoteTexts } from "@/lib/agents/epic-notes";
import { savePreset } from "@/lib/agents/presets";
import { resetAgents } from "@/lib/agents/registry";
import { repository } from "@/lib/db";
import { isQuestion, questionReason } from "@/lib/domain/question";
import { resetEnvCache } from "@/lib/secrets/env";
import { MockVcsClient, resetVcs, setVcs } from "@/lib/vcs";

/**
 * The PM and the agents' questions: an agent's question wakes it, and it either answers from
 * what the person already asked for or leaves it for them with a suggestion.
 */

const PROJECT = "project_default";
const REASON = questionReason("The Architect Agent", [
  { question: "Should the reduced-motion fix cover components too, or only globals.css?", why: "It sets the ticket's scope." },
]);

/** A stand-in OpenAI-format provider that replies from a script. */
function fakeProvider(replies: Array<Record<string, unknown>>) {
  const sent: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    const next = replies.shift();
    if (!next) throw new Error("No scripted reply left.");
    return Response.json({
      choices: [{ message: next, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  });
  return sent;
}

function call(id: string, name: string, args: unknown) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

async function useAgent(provider: "groq" | "claude-code") {
  const preset = await savePreset({
    name: "pm",
    provider,
    model: provider === "groq" ? "llama-3.3-70b" : "",
    prompt: "",
    apiKey: provider === "groq" ? "gsk_test" : "sk-ant-oat01-plan",
  });
  await repository().setAssistantAgent(PROJECT, preset.id);
}

async function waitingEpic(reason = REASON) {
  const repo = repository();
  const epic = await repo.createEpic({
    projectId: PROJECT,
    title: "Fix the Designer's audit",
    rawRequest: "Every animation is off under prefers-reduced-motion.",
    position: 1,
  });
  await repo.stallEpic(epic.id, { status: "blocked", stalledIn: "todo", stage: 3, reason });
  return epic;
}

beforeEach(() => {
  (globalThis as { __formicMemoryStore?: unknown }).__formicMemoryStore = undefined;
  MockVcsClient.reset();
  resetAgents();
  resetVcs();
  setVcs(new MockVcsClient("acme/widgets"));
  vi.stubEnv("AGENT_PROVIDER", "mock");
  vi.stubEnv("FORMIC_SECRET", "test");
  resetEnvCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetEnvCache();
  resetVcs();
});

describe("questionPrompt", () => {
  it("names the card, who asked and what, and says it is from Formic", () => {
    const text = questionPrompt({ key: "EPIC-9", title: "Motion" }, REASON);
    expect(text).toContain("[From Formic, not the person] The Architect Agent on EPIC-9 (Motion)");
    expect(text).toContain("Should the reduced-motion fix cover components too");
    expect(text).toContain("answer_question (own: true)");
  });
});

describe("the PM on call", () => {
  it("answers a question the person's own words settle, and the agent hears it as the PM's", async () => {
    const epic = await waitingEpic();
    await useAgent("groq");
    const sent = fakeProvider([
      {
        role: "assistant",
        content: null,
        tool_calls: [call("c1", "answer_question", { key: epic.key, answer: "Components too: the request says every animation.", own: true })],
      },
      { role: "assistant", content: "I answered the Architect: every animation, components included." },
    ]);

    await wakePm(PROJECT, epic.id, REASON);

    const messages = sent[0]!.messages as Array<{ role: string; content: string }>;
    expect(messages.at(-1)).toMatchObject({ role: "user" });
    expect(messages.at(-1)!.content).toContain("[From Formic, not the person]");
    expect(await epicNoteTexts(PROJECT, epic.id)).toEqual([
      expect.stringContaining("The PM answered for them, from what they already asked for: Components too"),
    ]);
    const chat = (await repository().assistantMessages(PROJECT)).messages;
    expect(chat).toHaveLength(1);
    expect(chat[0]).toMatchObject({ role: "assistant", status: "done", content: "I answered the Architect: every animation, components included." });
  });

  it("leaves a question only the person can settle waiting, with its suggestion in the PM chat", async () => {
    const epic = await waitingEpic();
    await useAgent("groq");
    fakeProvider([{ role: "assistant", content: "The Architect asks how wide the fix goes. I suggest components too. Reply here or in the card." }]);

    await wakePm(PROJECT, epic.id, REASON);

    expect(isQuestion((await repository().cardById(epic.id))?.blockedReason)).toBe(true);
    expect(await epicNoteTexts(PROJECT, epic.id)).toEqual([]);
    expect(((await repository().assistantMessages(PROJECT)).messages)[0]!.content).toContain("I suggest components too");
  });

  it("stays out of it with no PM agent, and for questions meant for the person alone", async () => {
    const epic = await waitingEpic();
    await wakePm(PROJECT, epic.id, REASON);
    expect((await repository().assistantMessages(PROJECT)).messages).toEqual([]);

    await useAgent("groq");
    const sent = fakeProvider([]);
    await wakePm(PROJECT, epic.id, questionReason("The Designer", [{ question: "Warm or cool?", why: "Taste." }]));
    expect(sent).toEqual([]);
    expect((await repository().assistantMessages(PROJECT)).messages).toEqual([]);
  });
});

describe("a CLI PM's answers", () => {
  it("passes on the answers it gives, and leaves a card the person already answered alone", async () => {
    const epic = await waitingEpic();
    const answered = await waitingEpic();
    await repository().stallEpic(answered.id, { status: "blocked", stalledIn: "todo", stage: 3, reason: "Something else broke." });
    const pending = await repository().addAssistantMessage({ projectId: PROJECT, role: "assistant", content: "", status: "pending" });

    await finishCliAnswer(
      pending.id,
      JSON.stringify({
        reply: "I answered the Architect.",
        proposals: [],
        answers: [
          { key: epic.key, answer: "Components too." },
          { key: answered.key, answer: "Not a question." },
        ],
      }),
      undefined,
      { projectId: PROJECT, attempt: 1 },
    );

    expect(await epicNoteTexts(PROJECT, epic.id)).toEqual([expect.stringContaining("The PM answered for them")]);
    expect(await epicNoteTexts(PROJECT, answered.id)).toEqual([]);
    expect((await repository().assistantMessage(pending.id))?.content).toBe("I answered the Architect.");
  });
});
