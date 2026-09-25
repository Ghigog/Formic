import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { activeProject } = vi.hoisted(() => ({ activeProject: vi.fn() }));

vi.mock("@/lib/board/project", () => ({
  activeProject,
  noProject: () => Response.json({ error: "Pick a repository first." }, { status: 409 }),
}));

const { GET, DELETE } = await import("./route");
const { repository } = await import("@/lib/db");

const PROJECT_A = "project-a";
const PROJECT_B = "project-b";

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_PRISMA_URL;
  delete process.env.POSTGRES_URL;
});

function req(url: string): NextRequest {
  return new NextRequest(url);
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function createUnclaimed(requestId: string) {
  return repository().createAttachment({
    projectId: PROJECT_A,
    requestId,
    filename: "notes.txt",
    mimeType: "text/plain",
    kind: "file",
    size: 5,
    bytes: new Uint8Array([1, 2, 3, 4, 5]),
  });
}

describe("GET /api/attachments/[id]", () => {
  it("fails the way an unpicked repository does when no project is active", async () => {
    activeProject.mockResolvedValue(null);
    const res = await GET(req("http://localhost/api/attachments/x"), params("x"));
    expect(res.status).toBe(409);
  });

  it("404s for an id that doesn't exist", async () => {
    activeProject.mockResolvedValue({ id: PROJECT_A });
    const res = await GET(req("http://localhost/api/attachments/nope"), params("nope"));
    expect(res.status).toBe(404);
  });

  it("streams the bytes and content type back for a still-unclaimed attachment, given its requestId", async () => {
    activeProject.mockResolvedValue({ id: PROJECT_A });
    const attachment = await createUnclaimed("req-1");

    const res = await GET(
      req(`http://localhost/api/attachments/${attachment.id}?requestId=req-1`),
      params(attachment.id),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5]);
  });

  it("serves an attachment claimed by a card the caller's project owns, with no requestId needed", async () => {
    activeProject.mockResolvedValue({ id: PROJECT_A });
    const attachment = await createUnclaimed("req-2");
    const epic = await repository().createEpic({
      projectId: PROJECT_A,
      title: "Epic",
      rawRequest: "Do the thing.",
      position: 1000,
    });
    await repository().claimAttachments("req-2", { epicId: epic.id });

    const res = await GET(
      req(`http://localhost/api/attachments/${attachment.id}`),
      params(attachment.id),
    );

    expect(res.status).toBe(200);
  });

  it("refuses an attachment claimed by another project's card, as not found", async () => {
    const attachment = await createUnclaimed("req-3");
    const epic = await repository().createEpic({
      projectId: PROJECT_A,
      title: "Epic",
      rawRequest: "Do the thing.",
      position: 1000,
    });
    await repository().claimAttachments("req-3", { epicId: epic.id });

    activeProject.mockResolvedValue({ id: PROJECT_B });
    const res = await GET(
      req(`http://localhost/api/attachments/${attachment.id}`),
      params(attachment.id),
    );

    expect(res.status).toBe(404);
  });

  it("refuses a still-unclaimed attachment to a caller that doesn't know its requestId", async () => {
    const attachment = await createUnclaimed("req-4");

    activeProject.mockResolvedValue({ id: PROJECT_B });
    const res = await GET(
      req(`http://localhost/api/attachments/${attachment.id}`),
      params(attachment.id),
    );

    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/attachments/[id]", () => {
  it("removes a still-unclaimed attachment given its requestId, from any project", async () => {
    activeProject.mockResolvedValue({ id: PROJECT_A });
    const attachment = await createUnclaimed("req-5");

    const res = await DELETE(
      req(`http://localhost/api/attachments/${attachment.id}?requestId=req-5`),
      params(attachment.id),
    );

    expect(res.status).toBe(200);
    expect(await repository().attachmentContent(attachment.id)).toBeNull();
  });

  it("removes an attachment claimed by a card the caller's project owns", async () => {
    activeProject.mockResolvedValue({ id: PROJECT_A });
    const attachment = await createUnclaimed("req-6");
    const epic = await repository().createEpic({
      projectId: PROJECT_A,
      title: "Epic",
      rawRequest: "Do the thing.",
      position: 1000,
    });
    await repository().claimAttachments("req-6", { epicId: epic.id });

    const res = await DELETE(
      req(`http://localhost/api/attachments/${attachment.id}`),
      params(attachment.id),
    );

    expect(res.status).toBe(200);
    expect(await repository().attachmentContent(attachment.id)).toBeNull();
  });

  it("refuses to delete an attachment claimed by another project's card, as not found, leaving it in place", async () => {
    const attachment = await createUnclaimed("req-7");
    const epic = await repository().createEpic({
      projectId: PROJECT_A,
      title: "Epic",
      rawRequest: "Do the thing.",
      position: 1000,
    });
    await repository().claimAttachments("req-7", { epicId: epic.id });

    activeProject.mockResolvedValue({ id: PROJECT_B });
    const res = await DELETE(
      req(`http://localhost/api/attachments/${attachment.id}`),
      params(attachment.id),
    );

    expect(res.status).toBe(404);
    expect(await repository().attachmentContent(attachment.id)).not.toBeNull();
  });
});
