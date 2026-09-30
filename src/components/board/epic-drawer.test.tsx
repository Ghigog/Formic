import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EpicDrawer } from "./epic-drawer";
import { makeCard } from "@/test/cards";
import type { AttachmentSummary, BoardCard, Prd } from "@/lib/domain/entities";

const PRD: Prd = {
  summary: "Deliver board export end to end.",
  problem: "People track work in spreadsheets.",
  scope: ["Stream the CSV"],
  outOfScope: [],
  technicalContext: [],
  userStories: ["As a board owner, I'd like to export my board."],
  successCriteria: ["The feature works end to end"],
};

const epic: BoardCard = makeCard({
  id: "e-1",
  kind: "epic",
  key: "EPIC-1",
  title: "Board export",
  status: "ready",
  stage: 3,
  size: null,
  childCount: 2,
  doneCount: 0,
});

function detail(overrides: Partial<{ epic: BoardCard; children: BoardCard[] }> = {}) {
  return {
    epic: overrides.epic ?? epic,
    title: epic.title,
    rawRequest: "Let people export their board as a CSV.",
    prd: PRD,
    showcase: null,
    children: overrides.children ?? [],
    canRetry: false,
    canGenerateShowcase: false,
  };
}

afterEach(() => vi.unstubAllGlobals());

function open(body: ReturnType<typeof detail> = detail(), attachments: AttachmentSummary[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/attachments")) return Response.json({ attachments });
      return Response.json(body);
    }),
  );
  render(<EpicDrawer epicId="e-1" onClose={() => {}} />);
}

describe("EpicDrawer", () => {
  it("shows the PRD as it was written", async () => {
    open();
    await screen.findByText("Board export");
    expect(screen.getByText(/Deliver board export end to end/)).toBeInTheDocument();
  });

  it("says nothing about a reroute for an Epic that was never moved", async () => {
    open();
    await screen.findByText("Board export");
    expect(screen.queryByText(/Moved from/)).not.toBeInTheDocument();
  });

  it("shows where a rerouted Epic came from and why, so it survives after the toast is gone", async () => {
    const rerouted = makeCard({
      ...epic,
      rerouteFrom: "backlog",
      rerouteReason: "Small enough for one ticket; skipping the PRD.",
    });
    open(detail({ epic: rerouted }));
    await screen.findByText("Board export");
    expect(
      screen.getByText("Moved from Backlog: Small enough for one ticket; skipping the PRD."),
    ).toBeInTheDocument();
  });

  it("shows an image thumbnail and a downloadable file chip for its attachments", async () => {
    const attachments: AttachmentSummary[] = [
      { id: "a-1", filename: "mock.png", mimeType: "image/png", kind: "image", size: 2048, url: "/api/attachments/a-1" },
      { id: "a-2", filename: "notes.txt", mimeType: "text/plain", kind: "file", size: 512, url: "/api/attachments/a-2" },
    ];
    open(detail(), attachments);
    await screen.findByText("Board export");

    const thumb = await screen.findByRole("button", { name: "Enlarge mock.png" });
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("href", "/api/attachments/a-2");

    thumb.click();
    const lightbox = await screen.findByRole("dialog", { name: "mock.png" });
    expect(within(lightbox).getByAltText("mock.png")).toHaveAttribute("src", "/api/attachments/a-1");
  });

  it("shows nothing where an Epic has no attachments", async () => {
    open();
    await screen.findByText("Board export");
    expect(screen.queryByText("Attachments")).not.toBeInTheDocument();
  });

  describe("generating a showcase", () => {
    const done = makeCard({ kind: "epic", key: "EPIC-1", title: "Board export", status: "merged", stage: 8, size: null });

    function openDone(
      overrides: { canGenerateShowcase?: boolean; showcase?: string | null; epic?: BoardCard } = {},
      post: () => Promise<Response> = async () => Response.json({ ok: true }),
    ) {
      const posts = vi.fn(post);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url.includes("/api/attachments")) return Response.json({ attachments: [] });
          if (url.endsWith("/showcase") && init?.method === "POST") return posts();
          return Response.json({
            ...detail({ epic: overrides.epic ?? done }),
            showcase: overrides.showcase ?? null,
            canGenerateShowcase: overrides.canGenerateShowcase ?? true,
          });
        }),
      );
      render(<EpicDrawer epicId="e-1" onClose={() => {}} />);
      return posts;
    }

    it("offers the button on a done Epic with no showcase, and posts on click", async () => {
      const posts = openDone();
      fireEvent.click(await screen.findByRole("button", { name: "Generate showcase" }));
      await waitFor(() => expect(posts).toHaveBeenCalledTimes(1));
    });

    it("hides the button once there is a showcase", async () => {
      openDone({ canGenerateShowcase: false, showcase: "Shipped." });
      await screen.findByText("Shipped.");
      expect(screen.queryByRole("button", { name: "Generate showcase" })).not.toBeInTheDocument();
    });

    it("hides the button on an Epic that is not done", async () => {
      openDone({ canGenerateShowcase: false, epic });
      await screen.findByText("Board export");
      expect(screen.queryByRole("button", { name: "Generate showcase" })).not.toBeInTheDocument();
    });

    it("disables the button while the request is in flight", async () => {
      let finish: (res: Response) => void = () => {};
      openDone({}, () => new Promise<Response>((resolve) => (finish = resolve)));
      const button = await screen.findByRole("button", { name: "Generate showcase" });
      fireEvent.click(button);
      await waitFor(() => expect(button).toBeDisabled());
      finish(Response.json({ ok: true }));
      await waitFor(() => expect(button).toBeEnabled());
    });

    it("disables the button while the PM Agent is running", async () => {
      openDone({ epic: { ...done, agentRole: "pm" } });
      expect(await screen.findByRole("button", { name: "Generate showcase" })).toBeDisabled();
    });

    it("shows the error when the request fails", async () => {
      openDone({}, async () => Response.json({ error: "EPIC-1 already has a showcase." }, { status: 409 }));
      fireEvent.click(await screen.findByRole("button", { name: "Generate showcase" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("EPIC-1 already has a showcase.");
    });
  });
});
