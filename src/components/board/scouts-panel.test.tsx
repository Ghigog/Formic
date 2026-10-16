import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeCard } from "@/test/cards";
import { ScoutsPanel } from "./scouts-panel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function serve(answer: object) {
  const posts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify(answer));
      }
      if (url.startsWith("/api/agents")) return new Response(JSON.stringify({ presets: [] }));
      return new Response(JSON.stringify(answer));
    }),
  );
  return posts;
}

describe("the scouts panel", () => {
  it("sends scouts on a ticket in To Do", async () => {
    const posts = serve({ why: null, scouts: [], max: 3, min: 2 });
    const card = makeCard({ status: "ready", stalledIn: null });
    const changed = vi.fn();
    render(<ScoutsPanel card={card} onChanged={changed} />);

    fireEvent.change(await screen.findByLabelText("How many scouts"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Send 3 scouts" }));
    await waitFor(() => expect(posts).toEqual([{ action: "send", ticketId: card.id, count: 3, presets: [null, null, null] }]));
    expect(changed).toHaveBeenCalled();
  });

  it("shows the scouts back and lets a person keep another one", async () => {
    const posts = serve({
      why: "S1 is smallest.",
      scouts: [
        { id: "s1", label: "S1", approach: "smallest", status: "back", summary: "small", reason: null, picked: true },
        { id: "s2", label: "S2", approach: "most robust", status: "back", summary: "with tests", reason: null, picked: false },
      ],
    });
    const card = makeCard({ status: "review", scouts: 2, scoutPick: "s1", prNumber: 4 });
    render(<ScoutsPanel card={card} onChanged={() => {}} />);

    expect(await screen.findByText("S1 is smallest.")).toBeTruthy();
    expect(screen.getByText("Kept")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep this one" }));
    await waitFor(() => expect(posts).toEqual([{ action: "swap", ticketId: card.id, scoutId: "s2" }]));
  });

  it("shows nothing on a ticket already started without scouts", () => {
    serve({ why: null, scouts: [] });
    const { container } = render(<ScoutsPanel card={makeCard({ status: "running" })} onChanged={() => {}} />);
    expect(container.innerHTML).toBe("");
  });
});
