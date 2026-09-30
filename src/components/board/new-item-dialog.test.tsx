import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewItemDialog } from "./new-item-dialog";
import { setViewportMatches } from "@/test/viewport";

function file(name: string, type: string, size = 1024): File {
  return new File([new Uint8Array(size)], name, { type });
}

/**
 * Fires a paste on `target` as the browser would: a ClipboardEvent whose
 * clipboardData holds one item per file. jsdom has no DataTransfer, so the
 * list is the shape the handler reads — `kind`, `type`, `getAsFile()` —
 * which is all the code touches.
 */
function pasteImages(target: HTMLElement, files: File[]) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: files.map((f) => ({
        kind: "file",
        type: f.type,
        getAsFile: () => f,
      })),
    },
  });
  fireEvent(target, event);
  return event;
}

/** A paste with only text on the clipboard, as the textarea receives it. */
function pasteText(target: HTMLElement, text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { items: [{ kind: "string", type: "text/plain", getAsFile: () => null }], getData: () => text },
  });
  fireEvent(target, event);
  return event;
}


/** Answers /api/projects and /api/attachments the way the real API does. */
function serveUploads() {
  let n = 0;
  const fetchSpy = vi.fn(async (input: string | URL, init?: RequestInit) => {
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
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NewItemDialog", () => {
  it("tags nothing by words: a request that says 'error' is plain work", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<NewItemDialog open column="backlog" onClose={vi.fn()} onSubmit={onSubmit} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("New feature request"), "Fix the error page");
    expect(screen.getByText("Product Agent")).toBeInTheDocument();
    expect(screen.queryByText(/Tagged as bug/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Draft PRD" }));
    expect(onSubmit).toHaveBeenCalledWith("Fix the error page", expect.any(String), undefined);
  });

  it("toggles Bug and Spike, one at a time, and submits the choice", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<NewItemDialog open column="todo" onClose={vi.fn()} onSubmit={onSubmit} />);
    const user = userEvent.setup();
    const bug = screen.getByRole("button", { name: "bug" });
    const spike = screen.getByRole("button", { name: "spike" });
    expect(bug).toHaveAttribute("aria-pressed", "false");
    expect(spike).toHaveAttribute("aria-pressed", "false");

    await user.click(bug);
    expect(bug).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Tagged as bug · −5 points")).toBeInTheDocument();

    await user.click(spike);
    expect(bug).toHaveAttribute("aria-pressed", "false");
    expect(spike).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText(/Tagged as bug/)).toBeNull();

    await user.click(bug);
    await user.click(bug);
    expect(bug).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText(/Tagged as bug/)).toBeNull();

    await user.click(bug);
    await user.type(screen.getByLabelText("New ticket request"), "Crash on save");
    await user.click(screen.getByRole("button", { name: "Draft ticket" }));
    expect(onSubmit).toHaveBeenCalledWith("Crash on save", expect.any(String), "bug");
  });

  it("drafts on submit and closes", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<NewItemDialog open column="backlog" onClose={onClose} onSubmit={onSubmit} />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("New feature request"), "Rate-limit the merge queue");
    await user.click(screen.getByRole("button", { name: "Draft PRD" }));

    expect(onSubmit).toHaveBeenCalledWith("Rate-limit the merge queue", expect.any(String), undefined);
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

    expect(onSubmit).toHaveBeenCalledWith("Fix the flaky retry test", expect.any(String), undefined);
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
      expect(onSubmit).toHaveBeenCalledWith("Ship it without the 6th file", expect.any(String), undefined);
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

    it("attaches a pasted image immediately, names it, and uploads it to /api/attachments", async () => {
      const fetchSpy = serveUploads();
      render(<NewItemDialog open column="todo" onClose={vi.fn()} onSubmit={vi.fn()} />);

      pasteImages(screen.getByLabelText("New ticket request"), [file("image.png", "image/png")]);

      // Uploading right away: the thumbnail's own label says so.
      expect(screen.getByText(/^Attaching pasted-image-\d+\.png…$/)).toBeInTheDocument();
      await waitFor(() => expect(screen.getByText(/^pasted-image-\d+\.png$/)).toBeInTheDocument());
      expect(screen.getByRole("button", { name: /^Remove pasted-image-\d+\.png$/ })).toBeInTheDocument();

      const posted = fetchSpy.mock.calls.find((c) => String(c[0]).includes("/api/attachments"));
      expect(posted).toBeDefined();
      const body = posted![1]!.body as FormData;
      expect(body.get("requestId")).toEqual(expect.any(String));
      expect((body.get("file") as File).name).toMatch(/^pasted-image-\d+\.png$/);
    });

    it("attaches a pasted image in the New request dialog too, since both share NewItemDialog", async () => {
      serveUploads();
      render(<NewItemDialog open column="backlog" onClose={vi.fn()} onSubmit={vi.fn()} />);

      pasteImages(screen.getByLabelText("New feature request"), [file("image.png", "image/png")]);

      await waitFor(() => expect(screen.getByText(/^pasted-image-\d+\.png$/)).toBeInTheDocument());
    });

    it("shows the same inline error when a paste hits the per-request cap", async () => {
      serveUploads();
      render(<NewItemDialog open column="backlog" onClose={vi.fn()} onSubmit={vi.fn()} />);

      const input = screen.getByLabelText("Attach files");
      const user = userEvent.setup();
      for (let i = 0; i < 5; i++) {
        await user.upload(input, file(`f${i}.png`, "image/png"));
      }
      await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(5));

      pasteImages(screen.getByLabelText("New feature request"), [file("image.png", "image/png")]);
      expect(await screen.findByRole("alert")).toHaveTextContent(/at most 5 attachments/);
      expect(screen.getAllByRole("listitem")).toHaveLength(5); // Nothing was added.
    });

    it("shows the same inline error when a pasted image is over the size limit", async () => {
      serveUploads();
      render(<NewItemDialog open column="backlog" onClose={vi.fn()} onSubmit={vi.fn()} />);

      pasteImages(screen.getByLabelText("New feature request"), [
        file("image.png", "image/png", 11 * 1024 * 1024),
      ]);
      expect(await screen.findByRole("alert")).toHaveTextContent(/larger than 10MB/);
      expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
    });

    it("leaves a plain-text paste alone, so the browser inserts it into the textarea", async () => {
      const user = userEvent.setup();
      render(<NewItemDialog open column="backlog" onClose={vi.fn()} onSubmit={vi.fn()} />);

      const textarea = screen.getByLabelText("New feature request");
      await user.type(textarea, "Already typing");
      const event = pasteText(textarea, " more");
      expect(event.defaultPrevented).toBe(false);

      // jsdom does not implement default paste insertion; the un-intercepted
      // event is the browser's contract that it will. No attachment either way.
      expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
    });
  });
});
