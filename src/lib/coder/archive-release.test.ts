import { describe, expect, it } from "vitest";
import { repository } from "@/lib/db";
import { releaseWaiting } from "./stack";

const PROJECT = "project_default";

/** The archive route's steps, on the in-memory store. */
async function archive(id: string) {
  const repo = repository();
  await repo.updateTicket(id, { archived: true });
  await repo.removeDependenciesOn(id);
  await releaseWaiting(PROJECT);
}

describe("archiving a ticket releases the tickets that depended on it", () => {
  it("readies B, which depended only on A, and keeps C waiting on its unmerged D", async () => {
    const repo = repository();
    const epic = await repo.createEpic({ projectId: PROJECT, title: "E", rawRequest: "E", position: 1 });
    const t = (key: string, position: number, dependsOnKeys: string[]) => ({
      epicId: epic.id, key, title: key, description: key, acceptanceCriteria: ["a"],
      fileScope: [`src/${key}`], size: "S" as const, position, dependsOnKeys,
    });
    const made = await repo.createTickets([t("A", 1, []), t("D", 2, []), t("B", 3, ["A"]), t("C", 4, ["A", "D"])]);
    const id = (k: string) => made.find((c) => c.key === k)!.id;
    expect((await repo.ticketDetail(id("B")))!.status).toBe("waiting");

    await archive(id("A"));

    const cards = await repo.boardCards(PROJECT);
    const b = cards.find((c) => c.id === id("B"))!;
    const c = cards.find((x) => x.id === id("C"))!;
    expect(b.dependsOn).toEqual([]);
    expect(b.status).toBe("ready");
    expect(c.dependsOn).toEqual([id("D")]);
    expect(c.status).toBe("waiting");
  });
});
