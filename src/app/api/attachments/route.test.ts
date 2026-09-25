import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { MAX_ATTACHMENTS_PER_REQUEST, MAX_ATTACHMENT_BYTES } from "@/lib/attachments/limits";

const { activeProject } = vi.hoisted(() => ({ activeProject: vi.fn() }));

vi.mock("@/lib/board/project", () => ({
  activeProject,
  noProject: () => Response.json({ error: "Pick a repository first." }, { status: 409 }),
}));

const { POST } = await import("./route");
const { repository } = await import("@/lib/db");

const PROJECT = "project-a";

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_PRISMA_URL;
  delete process.env.POSTGRES_URL;
  activeProject.mockResolvedValue({ id: PROJECT });
});

function file(name: string, type: string, size = 1024): File {
  return new File([new Uint8Array(size)], name, { type });
}

function request(form: FormData): NextRequest {
  return new NextRequest("http://localhost/api/attachments", { method: "POST", body: form });
}

function form(fields: Record<string, string | File>): FormData {
  const f = new FormData();
  for (const [key, value] of Object.entries(fields)) f.set(key, value);
  return f;
}

describe("POST /api/attachments", () => {
  it("fails the way an unpicked repository does when no project is active", async () => {
    activeProject.mockResolvedValue(null);

    const res = await POST(
      request(form({ requestId: "req-1", projectId: PROJECT, file: file("a.png", "image/png") })),
    );

    expect(res.status).toBe(409);
  });

  it("uploads a file within the limits and returns an id, filename and url", async () => {
    const res = await POST(
      request(
        form({ requestId: "req-1", projectId: PROJECT, file: file("shot.png", "image/png") }),
      ),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.attachment).toMatchObject({ filename: "shot.png", kind: "image" });
    expect(body.attachment.id).toBeTruthy();
    expect(body.attachment.url).toBe(`/api/attachments/${body.attachment.id}?requestId=req-1`);
  });

  it("rejects a file over the size limit, naming the limit, and leaves nothing behind", async () => {
    const res = await POST(
      request(
        form({
          requestId: "req-1",
          projectId: PROJECT,
          file: file("big.png", "image/png", MAX_ATTACHMENT_BYTES + 1),
        }),
      ),
    );

    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/larger than/i);
    expect(await repository().attachmentsFor({ requestId: "req-1" })).toEqual([]);
  });

  it("rejects a disallowed MIME type", async () => {
    const res = await POST(
      request(
        form({ requestId: "req-1", projectId: PROJECT, file: file("script.exe", "application/x-msdownload") }),
      ),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/x-msdownload/);
  });

  it("rejects one more attachment once the request is already at the cap, leaving the existing ones untouched", async () => {
    for (let i = 0; i < MAX_ATTACHMENTS_PER_REQUEST; i++) {
      const res = await POST(
        request(form({ requestId: "req-1", projectId: PROJECT, file: file(`f${i}.png`, "image/png") })),
      );
      expect(res.status).toBe(201);
    }

    const before = await repository().attachmentsFor({ requestId: "req-1" });
    expect(before).toHaveLength(MAX_ATTACHMENTS_PER_REQUEST);

    const res = await POST(
      request(form({ requestId: "req-1", projectId: PROJECT, file: file("one-too-many.png", "image/png") })),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(new RegExp(String(MAX_ATTACHMENTS_PER_REQUEST)));
    expect(await repository().attachmentsFor({ requestId: "req-1" })).toEqual(before);
  });

  it("refuses a projectId that doesn't match the active project", async () => {
    const res = await POST(
      request(
        form({ requestId: "req-1", projectId: "some-other-project", file: file("a.png", "image/png") }),
      ),
    );

    expect(res.status).toBe(400);
  });

  it("rejects a request with no file", async () => {
    const res = await POST(request(form({ requestId: "req-1", projectId: PROJECT })));
    expect(res.status).toBe(400);
  });
});
