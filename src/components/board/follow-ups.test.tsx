import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { FollowUps } from "./follow-ups";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const FOLLOW_UPS = [
  {
    title: "Raise branch coverage to 78%",
    why: "About 540 branches are uncovered.",
    points: 5 as const,
    need: "nice" as const,
  },
  {
    title: "Fix order-dependent tests",
    why: "They fail when shuffled.",
    points: null,
    need: "nice" as const,
  },
];

const NAV = { onOpenCard: () => {}, onOpenChat: () => {} };

function serve(status = 200, body: object = { message: "ok" }) {
  const posts: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return posts;
}

describe("a ticket's follow-ups", () => {
  it("shows each with its estimate and reason", () => {
    render(
      <FollowUps
        ticketId="t1"
        followUps={FOLLOW_UPS}
        onChanged={() => {}}
        {...NAV}
      />,
    );
    expect(
      screen.getByText("Raise branch coverage to 78%"),
    ).toBeInTheDocument();
    expect(screen.getByText("5 pt")).toBeInTheDocument();
    expect(screen.getByText("They fail when shuffled.")).toBeInTheDocument();
  });

  it("adds one as a ticket, or dismisses one, and reloads the ticket", async () => {
    const posts = serve();
    const changed = vi.fn();
    render(
      <FollowUps
        ticketId="t1"
        followUps={FOLLOW_UPS}
        onChanged={changed}
        {...NAV}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Add ticket" })[0]!);
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[1]!);
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(2));

    expect(posts).toEqual([
      { url: "/api/tickets/t1/follow-ups", body: { index: 0, add: true } },
      { url: "/api/tickets/t1/follow-ups", body: { index: 1, add: false } },
    ]);
  });

  it("says why when it cannot", async () => {
    serve(409, { error: "That follow-up is no longer there." });
    render(
      <FollowUps
        ticketId="t1"
        followUps={FOLLOW_UPS}
        onChanged={() => {}}
        {...NAV}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Add ticket" })[0]!);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That follow-up is no longer there.",
    );
  });

  it("shows nothing when there are none", () => {
    const { container } = render(
      <FollowUps ticketId="t1" followUps={[]} onChanged={() => {}} {...NAV} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  describe("with an outcome", () => {
    const withOutcome = [
      {
        title: "A",
        why: "a",
        points: null,
        need: "needed" as const,
        outcome: { kind: "added" as const, key: "EPIC-1-T9", cardId: "c9" },
      },
      {
        title: "B",
        why: "b",
        points: null,
        need: "nice" as const,
        outcome: { kind: "proposed" as const, messageId: "m1" },
      },
      {
        title: "C",
        why: "c",
        points: null,
        need: "nice" as const,
        outcome: { kind: "dismissed" as const },
      },
    ];

    it("shows a chip for each, with its label and no buttons to answer", () => {
      render(
        <FollowUps
          ticketId="t1"
          followUps={withOutcome}
          onChanged={() => {}}
          {...NAV}
        />,
      );
      expect(
        screen.getByRole("button", { name: "Added as EPIC-1-T9" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Proposed in chat" }),
      ).toBeInTheDocument();
      expect(screen.getByText("Dismissed")).toBeInTheDocument();
      expect(screen.getByText("Needed")).toBeInTheDocument();
      expect(screen.getAllByText("Nice to have")).toHaveLength(2);
      expect(screen.queryByRole("button", { name: "Add ticket" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    });

    it("opens the card or the chat from its chip", () => {
      const onOpenCard = vi.fn();
      const onOpenChat = vi.fn();
      render(
        <FollowUps
          ticketId="t1"
          followUps={withOutcome}
          onChanged={() => {}}
          onOpenCard={onOpenCard}
          onOpenChat={onOpenChat}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Added as EPIC-1-T9" }),
      );
      expect(onOpenCard).toHaveBeenCalledWith("c9");
      fireEvent.click(screen.getByRole("button", { name: "Proposed in chat" }));
      expect(onOpenChat).toHaveBeenCalled();
    });
  });
});
