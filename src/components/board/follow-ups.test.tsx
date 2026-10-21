import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FollowUps } from "./follow-ups";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const FOLLOW_UPS = [
  { title: "Raise branch coverage to 78%", why: "About 540 branches are uncovered.", points: 5 as const },
  { title: "Fix order-dependent tests", why: "They fail when shuffled.", points: null },
];

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
    render(<FollowUps ticketId="t1" followUps={FOLLOW_UPS} onChanged={() => {}} />);
    expect(screen.getByText("Raise branch coverage to 78%")).toBeInTheDocument();
    expect(screen.getByText("5 pt")).toBeInTheDocument();
    expect(screen.getByText("They fail when shuffled.")).toBeInTheDocument();
  });

  it("adds one as a ticket, or dismisses one, and reloads the ticket", async () => {
    const posts = serve();
    const changed = vi.fn();
    render(<FollowUps ticketId="t1" followUps={FOLLOW_UPS} onChanged={changed} />);

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
    render(<FollowUps ticketId="t1" followUps={FOLLOW_UPS} onChanged={() => {}} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Add ticket" })[0]!);
    expect(await screen.findByRole("alert")).toHaveTextContent("That follow-up is no longer there.");
  });

  it("shows nothing when there are none", () => {
    const { container } = render(<FollowUps ticketId="t1" followUps={[]} onChanged={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
