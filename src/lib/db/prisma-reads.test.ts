import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What a read asks Postgres for, asserted on the query itself.
 *
 * The database bills for what leaves it, and the app's worst offenders were
 * invisible from the outside: `attachmentsFor` selected every file's `bytes`
 * and then threw them away in `toAttachmentSummary`, an attachment read
 * authorized itself by pulling the whole board and then every card's
 * attachments one by one, and `createAttachment`'s INSERT ... RETURNING
 * handed the file straight back. Each is a single word in a query, so none of
 * them is caught by a test of behaviour, and each one is paid for on every
 * load.
 *
 * The client is a fake that records its arguments. Nothing here connects to a
 * database.
 */

const { calls, fake } = vi.hoisted(() => {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const empty = (method: string) => (args: Record<string, unknown>) => {
    calls.push({ method, args });
    return Promise.resolve([]);
  };
  const fake = {
    epic: { findMany: empty("epic.findMany") },
    ticket: { findMany: empty("ticket.findMany") },
    attachment: {
      findMany: empty("attachment.findMany"),
      findUnique: empty("attachment.findUnique"),
      create: (args: Record<string, unknown>) => {
        calls.push({ method: "attachment.create", args });
        return Promise.resolve({
          id: "att_1",
          filename: "shot.png",
          mimeType: "image/png",
          kind: "image",
          size: 5,
        });
      },
    },
  };
  return { calls, fake };
});

vi.mock("./client", () => ({ prisma: () => fake }));

const { PrismaRepository } = await import("./prisma-repository");

function argsOf(method: string): Record<string, unknown> {
  const call = calls.find((c) => c.method === method);
  expect(call, `${method} was never asked`).toBeDefined();
  return call!.args;
}

function selectOf(method: string): Record<string, unknown> {
  const args = argsOf(method);
  expect(args.select, `${method} read the whole row`).toBeDefined();
  return args.select as Record<string, unknown>;
}

/** Every column the query must not touch, named so a failure says which. */
function expectAbsent(select: Record<string, unknown>, fields: string[], what: string) {
  for (const field of fields) {
    expect(select, `${what} read ${field}`).not.toHaveProperty(field);
  }
}

beforeEach(() => {
  calls.length = 0;
});

describe("what a read asks Postgres for", () => {
  it("lists attachments without their contents", async () => {
    await new PrismaRepository().attachmentsFor({ requestId: "req-1" });

    const select = selectOf("attachment.findMany");
    expect(select).toMatchObject({
      id: true,
      filename: true,
      mimeType: true,
      kind: true,
      size: true,
    });
    expectAbsent(select, ["bytes", "projectId", "epicId", "ticketId"], "attachment.findMany");
  });

  it("answers an upload without handing the file back", async () => {
    await new PrismaRepository().createAttachment({
      projectId: "project-1",
      requestId: "req-1",
      filename: "shot.png",
      mimeType: "image/png",
      kind: "image",
      size: 5,
      bytes: new Uint8Array([1, 2, 3, 4, 5]),
    });

    expectAbsent(selectOf("attachment.create"), ["bytes"], "attachment.create");
  });

  it("authorizes one attachment in one query, without the board", async () => {
    await new PrismaRepository().attachmentScope("att_1");

    expect(selectOf("attachment.findUnique")).toEqual({
      projectId: true,
      requestId: true,
    });
    expect(calls.map((c) => c.method)).toEqual(["attachment.findUnique"]);
  });

  it("draws a board without reading an Epic's PRD, showcase or raw request", async () => {
    await new PrismaRepository().boardCards("project-1");

    const select = selectOf("epic.findMany");
    expectAbsent(
      select,
      ["rawRequest", "prd", "prdEditedByHuman", "prdUpdatedAt", "showcase", "runnerAgent", "issueNumber"],
      "epic.findMany",
    );
    // Still everything a card is drawn from, or the board renders blank.
    expect(select).toMatchObject({ id: true, title: true, status: true, position: true });
  });

  it("draws a board without reading a ticket's text", async () => {
    await new PrismaRepository().boardCards("project-1");

    const select = selectOf("ticket.findMany");
    expectAbsent(
      select,
      [
        "description",
        "acceptanceCriteria",
        "plan",
        "handoff",
        "scopeRequest",
        "summary",
        "reviewedSha",
        "reviewedHead",
        "attempts",
        "tokensIn",
        "tokensOut",
        "runnerAgent",
      ],
      "ticket.findMany",
    );
    expect(select).toMatchObject({ id: true, key: true, title: true, status: true, position: true });
  });
});
