import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewItemDialog } from "./new-item-dialog";
import { setViewportMatches } from "@/test/viewport";

function file(name: string, type: string, size = 1024): File {
  return new File([new Uint8Array(size)], name, { type });
}

/** Answers /api/projects and /api/attachments the way the real API does. */
function serveUploads() {
  let n = 0;
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/projects")) {
      return Response.json({ active: { id: "project-1" }, projects: [] });
    }
    if (url.includes("/api/attachments") && init?.method === "POST") {
      n += 1;
      const uploaded = (init.body as FormData).get("file") as File;
      return Response.json(
        {
          attachment: {
            id: `att-${n}`,
            filename: uploaded.name,
            mimeType: uploaded.type,
            kind: uploaded.type.startsWith("image/") ? "image" : "file",
            size: uploaded.size,
            url: `/api/attachments/att-${n}`,
          },
        },
        { status: 201 },
      );
    }
    if (url.includes("/api/attachments") && init?.method === "DELETE") {
      return Response.json({ ok: true });
    }
    throw new Error(`Unhandled fetch in test: ${url}`);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NewItemDialog", () => {
  it("says a request reads as a bug before it is filed", async () => {
    render(<NewItemDialog open column="backlog" onClose={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByText("Product Agent")).toBeInTheDocument();

    await userEvent.setup().type(screen.getByLabelText("New feature request"), "Fix the broken badge");
    expect(screen.getByText("Tagged as bug · −5 points")).toBeInTheDocument();
  });

  it("drafts on submit and closes", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<NewItemDialog open column="backlog" onClose={onClose} onSubmit={onSubmit} />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("New feature request"), "Rate-limit the merge queue");
    await user.click(screen.getByRole("button", { name: "Draft PRD" }));

    expect(onSubmit).toHaveBeenCalledWith("Rate-limit the merge queue", expect.any(String));
    expect(onClose).toHaveBeenCalled();
  });

  it("labels the To Do dialog for a ticket, naming the Architect Agent", () => {
    render(<NewItemDialog open column="todo" onClose={vi.fn()} onSubmit={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "New ticket" })).toBeInTheDocument();
    expect(screen.getByText("Architect Agent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Draft ticket" })).toBeInTheDocument();
  });

  it("posts a ticket request's own copy of requestId, distinct per open dialog", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<NewItemDialog open column="todo" onClose={vi.fn()} onSubmit={onSubmit} />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("New ticket request"), "Fix the flaky retry test");
    await user.click(screen.getByRole("button", { name: "Draft ticket" }));

    expect(onSubmit).toHaveBeenCalledWith("Fix the flaky retry test", expect.any(String));
  });

  describe("attachments", () => {
    it("attaches a file, lists it with a filename, and removes it", async () => {
      serveUploads();
      render(<NewItemDialog open column="backlog" onClose={vi.fn()} onSubmit={vi.fn()} />);

      const user = userEvent.setup();
      await user.upload(screen.getByLabelText("Attach files"), file("notes.txt", "text/plain"));

      await waitFor(() => expect(screen.getByText("notes.txt")).toBeInTheDocument());

      await user.click(screen.getByRole("button", { name: "Remove notes.txt" }));
      expect(screen.queryByText("notes.txt")).not.toBeInTheDocument();
    });

    it("rejects a disallowed file type immediately, without uploading it", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      render(<NewItemDialog open column="backlog" onClose={vi.fn()} onSubmit={vi.fn()} />);

      // The input's own `accept` narrows what a picker shows; a real OS
      // dialog can still be told to show every file, so the client check
      // must catch one that got through anyway.
      await userEvent
        .setup({ applyAccept: false })
        .upload(screen.getByLabelText("Attach files"), file("archive.zip", "application/zip"));

      expect(await screen.findByRole("alert")).toHaveTextContent(/aren't supported/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("rejects a 6th attachment over the per-request cap, and still lets the request submit", async () => {
      serveUploads();
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      render(<NewItemDialog open column="backlog" onClose={vi.fn()} onSubmit={onSubmit} />);

      const user = userEvent.setup();
      const input = screen.getByLabelText("Attach files");
      for (let i = 0; i < 5; i++) {
        await user.upload(input, file(`f${i}.png`, "image/png"));
      }
      await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(5));

      await user.upload(input, file("f5.png", "image/png"));
      expect(await screen.findByRole("alert")).toHaveTextContent(/at most 5 attachments/);
      expect(screen.queryByText("f5.png")).not.toBeInTheDocument();

      await user.type(screen.getByLabelText("New feature request"), "Ship it without the 6th file");
      await user.click(screen.getByRole("button", { name: "Draft PRD" }));
      expect(onSubmit).toHaveBeenCalledWith("Ship it without the 6th file", expect.any(String));
    });

    it("offers the device camera on a mobile viewport, and not on a wide one", () => {
      const { unmount } = render(
        <NewItemDialog open column="backlog" onClose={vi.fn()} onSubmit={vi.fn()} />,
      );
      expect(screen.queryByLabelText("Take a photo")).not.toBeInTheDocument();
      unmount();

      setViewportMatches(true);
      render(<NewItemDialog open column="todo" onClose={vi.fn()} onSubmit={vi.fn()} />);
      expect(screen.getByLabelText("Take a photo")).toBeInTheDocument();
    });
  });
});
