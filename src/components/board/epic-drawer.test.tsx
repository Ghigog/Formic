import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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
});
