import { beforeEach, describe, expect, it, vi } from "vitest";

const said = { text: "" };
vi.mock("@/lib/agents/presets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agents/presets")>()),
  assistantAgentFor: async () => ({
    kind: "api",
    info: { id: "anthropic", kind: "anthropic", label: "Anthropic" },
    model: "claude-sonnet-5",
    apiKey: "sk-ant",
    brief: null,
  }),
}));
vi.mock("@/lib/agents/chat-loop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agents/chat-loop")>()),
  claudeSpeak: () => async () => ({ text: said.text, calls: [], usage: { model: "m", tokensIn: 0, tokensOut: 0, costCents: 0 } }),
}));

import { overseeBreakdown, overseeChange, PM_NOTE_PREFIX } from "./oversight";
import { repository } from "@/lib/db";
import { epicNoteTexts } from "@/lib/agents/epic-notes";
import { noteTexts } from "@/lib/coder/notes";
import { isQuestion } from "@/lib/domain/question";
import type { VcsClient } from "@/lib/vcs";

const PROJECT = "p1";
const origin = { epic: "Board swap", request: "Swipe with three fingers to switch boards.", summary: "Swap boards." };
const client = {
  compare: async () => ({ files: ["src/board.tsx"], messages: [], headSha: "h", patches: [{ path: "src/board.tsx", patch: "+<button>Pull tab</button>" }] }),
  readFile: async () => null,
} as unknown as VcsClient;
const change = { client, base: "main", head: "feat", ref: "main" };
const ticket = { id: "", key: "T-4", title: "Swap boards", description: "Wire it.", acceptanceCriteria: ["It swaps"] };

async function seed() {
  const repo = repository();
  const epic = await repo.createEpic({ projectId: PROJECT, title: "Board swap", rawRequest: origin.request, position: 1 });
  const [made] = await repo.createTickets([
    { epicId: epic.id, key: "T-4", title: "Swap boards", description: "Wire it.", acceptanceCriteria: ["It swaps"], fileScope: ["src"], size: "M", storyPoints: 3, position: 1, dependsOnKeys: [] },
  ]);
  return { epic, ticket: { ...ticket, id: made!.id } };
}

beforeEach(() => {
  (globalThis as { __formicMemoryStore?: unknown }).__formicMemoryStore = undefined;
});

describe("the PM at review", () => {
  it("says nothing when the work is on track", async () => {
    const { ticket } = await seed();
    said.text = JSON.stringify({ onTrack: true, forTheAgents: null, forThePerson: null });
    expect(await overseeChange(PROJECT, ticket, origin, change)).toBeNull();
    expect(await noteTexts(PROJECT, ticket.id)).toEqual([]);
    expect(await repository().cardChatMessages(ticket.id)).toEqual([]);
  });

  it("steps in when it drifts: a note the Reviewer reads, and its word in the card's chat", async () => {
    const { ticket } = await seed();
    said.text = JSON.stringify({ onTrack: false, forTheAgents: "They asked for a three-finger swipe, not a pull tab.", forThePerson: null });
    expect(await overseeChange(PROJECT, ticket, origin, change)).toBeNull();
    expect(await noteTexts(PROJECT, ticket.id)).toEqual(["From the PM: They asked for a three-finger swipe, not a pull tab."]);
    expect((await repository().cardChatMessages(ticket.id)).at(-1)?.content).toBe("**PM:** They asked for a three-finger swipe, not a pull tab.");
  });

  it("asks the person in plain words when only they can settle it", async () => {
    const { ticket } = await seed();
    said.text = JSON.stringify({ onTrack: false, forTheAgents: null, forThePerson: { question: "Should phones get the swipe first?", why: "Desktop needs more work." } });
    const reason = await overseeChange(PROJECT, ticket, origin, change);
    expect(isQuestion(reason)).toBe(true);
    expect(reason).toContain("The PM is waiting for your answer");
  });

  it("stays out of it when it cannot read the answer", async () => {
    const { ticket } = await seed();
    said.text = "Looks fine to me!";
    expect(await overseeChange(PROJECT, ticket, origin, change)).toBeNull();
  });
});

describe("the PM at planning", () => {
  const plan = [{ key: "T-1", title: "Pull tab", description: "A tab at the top.", acceptanceCriteria: ["Drag it"] }];

  it("has the Architect plan again once, with its correction among the Epic's notes", async () => {
    const { epic } = await seed();
    said.text = JSON.stringify({ onTrack: false, forTheAgents: "Use the three-finger swipe they asked for.", forThePerson: null });
    expect(await overseeBreakdown(PROJECT, epic.id, origin, plan, { correctedBefore: false })).toEqual({ kind: "replan" });
    expect(await epicNoteTexts(PROJECT, epic.id)).toEqual([`${PM_NOTE_PREFIX}Use the three-finger swipe they asked for.`]);
    expect(await overseeBreakdown(PROJECT, epic.id, origin, plan, { correctedBefore: true })).toEqual({ kind: "apply" });
  });
});
