import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { TicketDrawer } from "./ticket-drawer";
import { PlanSteps } from "@/components/ui/plan-steps";
import { makeCard } from "@/test/cards";
import type { FormicEvent } from "@/lib/domain/events";
import type { TicketView } from "@/lib/domain/ticket-view";
import type { AttachmentSummary } from "@/lib/domain/entities";
import { setViewportMatches } from "@/test/viewport";

const card = makeCard({
  id: "t-1",
  key: "T-1",
  title: "Export endpoint",
  status: "running",
  stage: 5,
  storyPoints: 5,
  fileScope: ["src/app/api/export"],
});

const VIEW: TicketView = {
  card,
  epic: { id: "e-1", key: "EPIC-1", title: "Board export" },
  description: [
    "**User story:** As a board owner, I'd like to export my board, so that I can report on it.",
    "",
    "### Context",
    "People track work in spreadsheets.",
    "",
    "### Requirements",
    "- Stream the CSV",
  ].join("\n"),
  acceptanceCriteria: ["Given a board, when I export it, then I get a CSV."],
  branchName: null,
  dependsOn: [],
  handoff: [],
  followUps: [],
  usage: { usedMinutes: 12, budgetMinutes: 20 },
  plan: [
    { step: "Read the board model", status: "done" },
    { step: "Add the endpoint", status: "in_progress" },
    { step: "Test it", status: "pending" },
  ],
  canStop: false,
  activity: [
    {
      seq: 1,
      at: "2026-09-23T16:00:00Z",
      kind: "thinking",
      text: "The model has a cards table.",
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

function open(view: TicketView = VIEW, attachments: AttachmentSummary[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/attachments"))
        return Response.json({ attachments });
      return Response.json(view);
    }),
  );
  const listeners = new Set<(e: FormicEvent, seq: number) => void>();
  const subscribe = (l: (e: FormicEvent, seq: number) => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };
  const onOpenEpic = vi.fn();
  const onOpenTicket = vi.fn();
  render(
    <TicketDrawer
      ticketId="t-1"
      onClose={() => {}}
      onOpenEpic={onOpenEpic}
      onOpenTicket={onOpenTicket}
      subscribe={subscribe}
    />,
  );
  const send = (e: FormicEvent, seq: number) =>
    act(() => listeners.forEach((l) => l(e, seq)));
  return { send, onOpenEpic, onOpenTicket };
}

describe("TicketDrawer notice", () => {
  const stalled = (
    status: "failed" | "blocked" | "waiting",
    reason: string,
  ): TicketView => ({
    ...VIEW,
    card: { ...card, status, stalledIn: "in_review", blockedReason: reason },
  });

  it("shows a red Warning banner with title, short and long description", async () => {
    open(stalled("failed", "CI broke\nline two of the log"));
    const banner = await screen.findByRole("alert");
    expect(banner.dataset.severity).toBe("warning");
    expect(banner.className).toContain("bg-crimson");
    expect(within(banner).getByText("Warning")).toBeInTheDocument();
    expect(within(banner).getByText("Failed")).toBeInTheDocument();
    expect(within(banner).getAllByText(/CI broke/)).toHaveLength(1);
    expect(within(banner).getAllByText(/line two of the log/)).toHaveLength(1);
  });

  it("shows a single-line failure once, with no gray block", async () => {
    open(stalled("failed", "The run timed out"));
    const banner = await screen.findByRole("alert");
    expect(within(banner).getAllByText("The run timed out")).toHaveLength(1);
    expect(banner.querySelector("pre")).toBeNull();
  });

  it("shows a yellow Alert banner for a ticket paused for authorization", async () => {
    open(stalled("blocked", "Needs files outside its scope: src/a.ts\nmore"));
    const banner = await screen.findByRole("alert");
    expect(banner.dataset.severity).toBe("alert");
    expect(banner.className).toContain("bg-clay");
    expect(within(banner).getByText("Alert")).toBeInTheDocument();
    expect(within(banner).getByText("Needs authorization")).toBeInTheDocument();
  });

  it("shows only the neutral text for a dependency wait", async () => {
    open(stalled("waiting", "Waiting on PROT-1"));
    await screen.findByText("Waiting on PROT-1");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("TicketDrawer work type", () => {
  it("offers no Bug or Spike buttons, even in To Do", async () => {
    openTodo({ ...VIEW, card: { ...card, status: "ready" } });
    await screen.findByText("Export endpoint");
    expect(screen.queryByRole("group", { name: "Work type" })).toBeNull();
    expect(screen.queryByRole("button", { name: /bug|spike/i })).toBeNull();
  });
});

function openTodo(view: TicketView) {
  const fetched: Array<[string, string, string | undefined]> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "PATCH") {
        fetched.push([url, "PATCH", init.body as string]);
        return Response.json({ ok: true });
      }
      if (url.includes("/api/attachments"))
        return Response.json({ attachments: [] });
      return Response.json(view);
    }),
  );
  render(
    <TicketDrawer
      ticketId="t-1"
      onClose={() => {}}
      onOpenEpic={() => {}}
      onOpenTicket={() => {}}
      subscribe={() => () => {}}
    />,
  );
  return { fetched };
}

describe("TicketDrawer", () => {
  it("stacks the header below sm so the title takes the full width", async () => {
    open();
    await screen.findByTitle("5 story points");
    const header = screen.getByTestId("drawer-header");
    expect(header).toHaveClass("flex-col-reverse", "sm:flex-row");
    const actions = screen.getByTestId("drawer-actions");
    expect(actions).toHaveClass("justify-end");
    expect(
      within(actions).getByRole("button", { name: "Close" }),
    ).toBeInTheDocument();
    expect(actions.previousElementSibling).toContainElement(
      screen.getByRole("heading", { level: 2 }),
    );
  });

  it("shows the story points and no T-shirt size", async () => {
    open();
    expect(await screen.findByTitle("5 story points")).toBeInTheDocument();
    expect(screen.queryByTitle("Ticket size")).not.toBeInTheDocument();
  });

  it("on mobile shows one full-width pane under the tabs, and switching swaps it", async () => {
    setViewportMatches(false);
    open();
    const ticket = await screen.findByRole("region", { name: "Ticket" });
    expect(
      screen.queryByRole("region", { name: "Agent" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    // The pane is the only child of the content area, so it takes the whole row.
    expect(ticket.parentElement?.children).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    const agent = await screen.findByRole("region", { name: "Agent" });
    expect(
      screen.queryByRole("region", { name: "Ticket" }),
    ).not.toBeInTheDocument();
    expect(agent.parentElement?.children).toHaveLength(1);
  });

  it("on desktop keeps both panes side by side with a divider", async () => {
    setViewportMatches(true);
    open();
    expect(
      await screen.findByRole("region", { name: "Ticket" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Agent" })).toBeInTheDocument();
    expect(
      screen.getByRole("separator", { name: "Resize the panes" }),
    ).toBeInTheDocument();
  });

  it("shows the ticket as it was written, with its story points", async () => {
    open();
    const ticket = await screen.findByRole("region", { name: "Ticket" });
    expect(within(ticket).getByText("User story:")).toBeInTheDocument();
    expect(within(ticket).getByText("Context")).toBeInTheDocument();
    expect(within(ticket).getByText("Stream the CSV")).toBeInTheDocument();
    expect(within(ticket).getByText(/I get a CSV/)).toBeInTheDocument();
    expect(screen.getByTitle("5 story points")).toHaveTextContent("5 pt");
  });

  it("shows the agent's plan under the title in place of the stage timeline", async () => {
    open();
    const plan = await screen.findByRole("list", { name: "Agent's plan" });
    expect(within(screen.getByTestId("drawer-plan")).getByText("Test it")).toBeInTheDocument();
    expect(plan).toHaveTextContent("Read the board model");
    expect(screen.queryByRole("list", { name: "Ticket progress" })).not.toBeInTheDocument();
    expect(screen.queryByText("Sandbox")).not.toBeInTheDocument();
  });

  it("shows no plan, no timeline and no Plan section until the agent has a plan", async () => {
    open({ ...VIEW, plan: [] });
    await screen.findByRole("region", { name: "Ticket" });
    expect(screen.queryByRole("list", { name: "Agent's plan" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Ticket progress" })).not.toBeInTheDocument();
    expect(screen.queryByText("Plan")).not.toBeInTheDocument();
  });

  it("adds a reviewer's plan after the coder's, then replaces only its own", async () => {
    const { send } = open();
    await screen.findByRole("list", { name: "Agent's plan" });
    const reviewer = (step: string) => ({ step, status: "pending" as const, role: "reviewer" as const });
    send({ type: "ticket.plan", ticketId: "t-1", steps: [reviewer("Check the diff")] }, 5);
    send({ type: "ticket.plan", ticketId: "t-1", steps: [reviewer("Check the tests")] }, 6);
    const items = within(screen.getByRole("list", { name: "Agent's plan" })).getAllByRole("listitem");
    expect(items.map((li) => li.textContent?.replace(/:.*$/, "").replace(/^\d+|^✓/, ""))).toEqual([
      "Read the board model",
      "Add the endpoint",
      "Test it",
      "Check the tests",
    ]);
  });

  it("shows the agent's plan and thinking, and follows them live", async () => {
    setViewportMatches(true);
    const { send } = open();
    const agent = await screen.findByRole("region", { name: "Agent" });
    const plan = screen.getByRole("list", { name: "Agent's plan" });
    expect(within(plan).getByText("Add the endpoint")).toHaveTextContent(
      "in progress",
    );
    expect(
      within(agent).getByText("The model has a cards table."),
    ).toBeInTheDocument();

    send(
      {
        type: "run.thought",
        runId: "r",
        ticketId: "t-1",
        kind: "text",
        text: "Writing the handler now.",
      },
      2,
    );
    send(
      {
        type: "run.thought",
        runId: "r",
        ticketId: "other",
        kind: "text",
        text: "Not this ticket.",
      },
      3,
    );
    send(
      {
        type: "ticket.plan",
        ticketId: "t-1",
        steps: [
          { step: "Read the board model", status: "done" },
          { step: "Add the endpoint", status: "done" },
          { step: "Test it", status: "in_progress" },
        ],
      },
      4,
    );

    expect(
      within(agent).getByText("Writing the handler now."),
    ).toBeInTheDocument();
    expect(
      within(agent).queryByText("Not this ticket."),
    ).not.toBeInTheDocument();
    expect(within(plan).getByText("Test it")).toHaveTextContent("in progress");
  });

  it("leads back to its Epic", async () => {
    const { onOpenEpic } = open();
    (
      await screen.findByRole("button", { name: /EPIC-1: Board export/ })
    ).click();
    expect(onOpenEpic).toHaveBeenCalledWith("e-1");
  });

  it("lists what it waits on as buttons that open that ticket", async () => {
    const dep = (id: string, key: string, title: string) => ({
      id,
      key,
      title,
      status: "running",
    });
    const { onOpenTicket } = open({
      ...VIEW,
      dependsOn: [dep("t-8", "T-8", "Schema"), dep("t-9", "T-9", "Auth")],
    });
    (await screen.findByRole("button", { name: /T-9.*Auth/ })).click();
    expect(onOpenTicket).toHaveBeenCalledWith("t-9");
    expect(
      screen.getByRole("button", { name: /T-8.*Schema/ }),
    ).toBeInTheDocument();
  });

  it("shows no Waits on section without dependencies", async () => {
    open();
    await screen.findByRole("button", { name: /EPIC-1: Board export/ });
    expect(screen.queryByText("Waits on")).not.toBeInTheDocument();
  });

  it("shows no What the agent changed section for a ticket that has been run", async () => {
    open({ ...VIEW, summary: "Added the CSV endpoint." } as TicketView);
    await screen.findByRole("button", { name: /EPIC-1: Board export/ });
    expect(
      screen.queryByText("What the agent changed"),
    ).not.toBeInTheDocument();
  });

  it("says nothing about a reroute for a ticket that was never moved", async () => {
    open();
    await screen.findByRole("region", { name: "Ticket" });
    expect(screen.queryByText(/Moved from/)).not.toBeInTheDocument();
  });

  it("shows where a rerouted ticket came from and why, so it survives after the toast is gone", async () => {
    const rerouted: TicketView = {
      ...VIEW,
      card: {
        ...VIEW.card,
        rerouteFrom: "todo",
        rerouteReason: "Too big for one ticket; needs a PRD.",
      },
    };
    open(rerouted);
    await screen.findByRole("region", { name: "Ticket" });
    expect(
      screen.getByText(
        "Moved from To Do: Too big for one ticket; needs a PRD.",
      ),
    ).toBeInTheDocument();
  });

  it("shows an image thumbnail and a downloadable file chip for its attachments", async () => {
    const attachments: AttachmentSummary[] = [
      {
        id: "a-1",
        filename: "mock.png",
        mimeType: "image/png",
        kind: "image",
        size: 2048,
        url: "/api/attachments/a-1",
      },
      {
        id: "a-2",
        filename: "notes.txt",
        mimeType: "text/plain",
        kind: "file",
        size: 512,
        url: "/api/attachments/a-2",
      },
    ];
    open(VIEW, attachments);
    const ticket = await screen.findByRole("region", { name: "Ticket" });

    const thumb = await within(ticket).findByRole("button", {
      name: "Enlarge mock.png",
    });
    expect(within(ticket).getByText("notes.txt")).toBeInTheDocument();
    expect(within(ticket).getByText("512 B")).toBeInTheDocument();
    expect(
      within(ticket).getByRole("link", { name: "Download" }),
    ).toHaveAttribute("href", "/api/attachments/a-2");

    thumb.click();
    const lightbox = await screen.findByRole("dialog", { name: "mock.png" });
    expect(within(lightbox).getByAltText("mock.png")).toHaveAttribute(
      "src",
      "/api/attachments/a-1",
    );
  });

  it("links the setup pull request a blocked ticket's reason names, so it can be clicked through", async () => {
    const url = "https://github.com/acme/widgets/pull/7";
    open({
      ...VIEW,
      card: makeCard({
        id: "t-1",
        key: "T-1",
        title: "Export endpoint",
        status: "blocked",
        blockedReason: `Claude Code runs in this repository's GitHub Actions. Merge the setup pull request once (${url}), then try again.`,
      }),
    });

    const link = await screen.findByRole("link", { name: url });
    expect(link).toHaveAttribute("href", url);
    expect(link).toHaveAttribute("target", "_blank");
    // The sentence around the link is still a sentence, in the alert banner
    expect(
      screen.getAllByText(/Merge the setup pull request once/).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Alert")).toBeInTheDocument();
  });

  it("does the same for a reason that is a wait, not a stall, such as a dependency", async () => {
    const url = "https://github.com/acme/widgets/pull/7";
    open({
      ...VIEW,
      card: makeCard({
        id: "t-1",
        key: "T-1",
        title: "Export endpoint",
        status: "waiting",
        blockedReason: `Waiting on the setup pull request (${url}) before it can start.`,
      }),
    });

    const link = await screen.findByRole("link", { name: url });
    expect(link).toHaveAttribute("href", url);
  });

  it("shows nothing where a ticket has no attachments", async () => {
    open();
    await screen.findByRole("region", { name: "Ticket" });
    expect(screen.queryByText("Attachments")).not.toBeInTheDocument();
  });
});

describe("PlanSteps", () => {
  it("marches ants from the current step while the agent works, and only then", () => {
    const steps = VIEW.plan;
    const { container, rerender } = render(<PlanSteps steps={steps} working />);
    expect(container.querySelectorAll(".ant-trail-vertical")).toHaveLength(1);
    rerender(<PlanSteps steps={steps} working={false} />);
    expect(container.querySelectorAll(".ant-trail-vertical")).toHaveLength(0);
  });
});

describe("TicketDrawer on-screen keyboard", () => {
  it("lifts the drawer above the keyboard and caps its height", () => {
    const vv = Object.assign(new EventTarget(), { height: 500, offsetTop: 0 });
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("visualViewport", vv);
    try {
      render(
        <TicketDrawer
          ticketId="t-1"
          onClose={() => {}}
          onOpenEpic={() => {}}
          onOpenTicket={() => {}}
          subscribe={() => () => {}}
        />,
      );
      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveStyle({ paddingBottom: "300px" });
      expect(dialog.firstElementChild).toHaveStyle({ maxHeight: "500px" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("TicketDrawer with the keyboard open", () => {
  it("hides the banner, plan and epic link, then restores them", async () => {
    const vv = Object.assign(new EventTarget(), { height: 800, offsetTop: 0 });
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("visualViewport", vv);
    open({
      ...VIEW,
      card: {
        ...card,
        status: "failed",
        stalledIn: "in_review",
        blockedReason: "CI broke",
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Agent" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByLabelText("Agent's plan")).toBeInTheDocument();
    act(() => {
      vv.height = 400;
      vv.dispatchEvent(new Event("resize"));
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Agent's plan")).not.toBeInTheDocument();
    expect(screen.queryByText(/in EPIC-1/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Agent" })).toBeInTheDocument();
    act(() => {
      vv.height = 800;
      vv.dispatchEvent(new Event("resize"));
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByLabelText("Agent's plan")).toBeInTheDocument();
    expect(screen.getByText(/in EPIC-1/)).toBeInTheDocument();
  });
});

describe("TicketDrawer archive", () => {
  const todo: TicketView = {
    ...VIEW,
    card: { ...card, status: "ready", queen: false },
  };

  function openWith(archive: () => Response) {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (init?.method === "PATCH") {
          calls.push(url);
          return archive();
        }
        if (url.includes("/api/attachments"))
          return Response.json({ attachments: [] });
        if (url.includes("/api/queens")) return Response.json({ unspent: 0 });
        return Response.json(todo);
      }),
    );
    const onClose = vi.fn();
    const onChanged = vi.fn();
    render(
      <TicketDrawer
        ticketId="t-1"
        onClose={onClose}
        onChanged={onChanged}
        onOpenEpic={() => {}}
        onOpenTicket={() => {}}
        subscribe={() => () => {}}
      />,
    );
    return { calls, onClose, onChanged };
  }

  it("archives the ticket and closes the drawer", async () => {
    const { calls, onClose, onChanged } = openWith(() =>
      Response.json({ ok: true }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls).toEqual(["/api/tickets/t-1/archive"]);
    expect(onChanged).toHaveBeenCalled();
  });

  it("shows the error and stays open when archiving fails", async () => {
    const { onClose } = openWith(() =>
      Response.json({ error: "Still working." }, { status: 409 }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Still working.",
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("puts Add Queen, the no-Queens note and Archive in one row", async () => {
    openWith(() => Response.json({ ok: true }));
    const archive = await screen.findByRole("button", { name: "Archive" });
    const addQueen = screen.getByRole("button", { name: "Add Queen" });
    expect(addQueen.closest("[data-queen]")?.parentElement).toBe(
      archive.parentElement,
    );
    expect(await screen.findByText("No unspent Queens")).toBeInTheDocument();
    expect(archive).toBeEnabled();
  });

  it("shares the Ticket/Agent tab row, with the error below it", async () => {
    openWith(() => Response.json({ error: "Still working." }, { status: 409 }));
    const archive = await screen.findByRole("button", { name: "Archive" });
    const row = screen.getByTestId("drawer-tab-row");
    expect(row).toContainElement(
      screen.getByRole("button", { name: "Ticket" }),
    );
    expect(row).toContainElement(
      screen.getByRole("button", { name: "Add Queen" }),
    );
    expect(row).toContainElement(archive);
    expect(screen.getByRole("button", { name: "Ticket" })).toHaveClass(
      "lg:hidden",
    );
    fireEvent.click(archive);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Still working.",
    );
    expect(row).toContainElement(screen.getByRole("alert"));
  });
});
