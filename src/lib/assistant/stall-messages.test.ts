import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/events/bus", () => ({ publish: vi.fn(async () => 1) }));

import { repository } from "@/lib/db";
import { resetMemoryStore } from "@/lib/db/memory-repository";
import type { FormicEvent } from "@/lib/domain/events";
import { reportStall, resetStallsReported } from "./stall-messages";

let projectId: string;
let cardId: string;

const stall = (status: string, blockedReason: string | null): FormicEvent => ({
  type: "card.status",
  cardId,
  kind: "ticket",
  status,
  stalledIn: "inProgress",
  stage: 0,
  blockedReason,
});

const messages = async () => (await repository().assistantMessages(projectId)).messages;

beforeEach(async () => {
  resetMemoryStore();
  resetStallsReported();
  const repo = repository();
  const project = await repo.ensureProject({ ownerId: null, repoFullName: "acme/pm", baseBranch: "main" });
  projectId = project.id;
  const epic = await repo.createEpic({ projectId, title: "E", rawRequest: "E", position: 1 });
  const [ticket] = await repo.createTickets([
    { epicId: epic.id, key: `${epic.key}-T1`, title: "Add login", description: "d", acceptanceCriteria: [], fileScope: [], position: 1, dependsOnKeys: [] },
  ]);
  cardId = ticket!.id;
});

describe("reportStall", () => {
  it("posts a question stall once, naming the card and linking it", async () => {
    await reportStall(projectId, stall("blocked", "Question: Which provider should login use?"));
    const message = (await messages())[0]!;
    expect(message.content).toContain("Add login needs you: Question for you.");
    expect(message.content).toContain("Which provider should login use?");
    expect(message.content).toContain("Answer in the card's chat");
    expect(message.cards).toEqual([expect.objectContaining({ id: cardId, title: "Add login" })]);
  });

  it("posts what is wrong for a Stuck stop", async () => {
    await reportStall(projectId, stall("blocked", "Run stuck: no new commits for 30 minutes\nrun 1 last ran tests"));
    const message = (await messages())[0]!;
    expect(message.content).toContain("Stuck.");
    expect(message.content).toContain("Run stuck: no new commits for 30 minutes");
    expect(message.content).toContain("run 1 last ran tests");
  });

  it("posts nothing for a repeat of the same stall", async () => {
    await reportStall(projectId, stall("blocked", "Question: Which?"));
    await reportStall(projectId, stall("blocked", "Question: Which?"));
    expect(await messages()).toHaveLength(1);
  });

  it("posts nothing for a usage-limit stop", async () => {
    await reportStall(projectId, stall("blocked", "Usage limit reached"));
    expect(await messages()).toHaveLength(0);
  });
});
