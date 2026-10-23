import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeCard } from "@/test/cards";
import { QueenPanel } from "./queen-panel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function serve(unspent: number, post: { status: number; body: object } = { status: 201, body: {} }) {
  const posts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify(post.body), { status: post.status });
      }
      return new Response(JSON.stringify({ unspent }));
    }),
  );
  return posts;
}

const todo = { status: "ready", stalledIn: null } as const;

describe("the queen panel", () => {
  it("shows an enabled Add Queen button on a Todo ticket with an unspent Queen", async () => {
    serve(1);
    render(<QueenPanel card={makeCard(todo)} onChanged={() => {}} />);
    const button = await screen.findByRole("button", { name: "Add Queen" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  });

  it.each(["running", "review", "merged"] as const)("shows nothing on a %s ticket", (status) => {
    serve(1);
    const { container } = render(<QueenPanel card={makeCard({ status, stalledIn: null })} onChanged={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows Remove Queen in place of Add Queen once the ticket has a Queen", () => {
    serve(1);
    render(<QueenPanel card={makeCard({ ...todo, queen: true })} onChanged={() => {}} />);
    expect(screen.getByRole("button", { name: "Remove Queen" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add Queen" })).toBeNull();
  });

  it("deletes the Queen on clicking Remove Queen and reports the change", async () => {
    const calls: { method?: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push({ method: init?.method, body: init?.body && JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ ok: true }));
      }),
    );
    const card = makeCard({ ...todo, queen: true });
    const changed = vi.fn();
    render(<QueenPanel card={card} onChanged={changed} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Queen" }));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(calls).toEqual([{ method: "DELETE", body: { cardId: card.id } }]);
  });

  it("disables the button and says why at 0 unspent", async () => {
    serve(0);
    render(<QueenPanel card={makeCard(todo)} onChanged={() => {}} />);
    await screen.findByText("No unspent Queens");
    expect((screen.getByRole("button", { name: "Add Queen" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("posts the card on click and reports the change", async () => {
    const posts = serve(1);
    const card = makeCard(todo);
    const changed = vi.fn();
    render(<QueenPanel card={card} onChanged={changed} />);
    const button = await screen.findByRole("button", { name: "Add Queen" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(posts).toEqual([{ cardId: card.id }]));
    await waitFor(() => expect(changed).toHaveBeenCalled());
  });

  it("shows the route's error on a 409 and keeps the button", async () => {
    serve(1, { status: 409, body: { error: "It already has a Queen." } });
    render(<QueenPanel card={makeCard(todo)} onChanged={() => {}} />);
    const button = await screen.findByRole("button", { name: "Add Queen" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toBe("It already has a Queen.");
    expect((screen.getByRole("button", { name: "Add Queen" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
