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
  it("sends one scout on a ticket in In Progress", async () => {
    const posts = serve({ why: null, scouts: [] });
    const card = makeCard({ status: "running", stalledIn: null });
    const changed = vi.fn();
    render(<ScoutsPanel card={card} onChanged={changed} />);

    fireEvent.click(await screen.findByRole("button", { name: "Scouts: 0" }));
    expect(screen.queryByText(/second attempt/)).toBeNull();
    await waitFor(() => expect(posts).toEqual([{ action: "send", ticketId: card.id }]));
    expect(changed).toHaveBeenCalled();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("shows one compact Scouts: N control with the count from the card", async () => {
    serve({ why: null, scouts: [{ id: "s1", label: "S1", approach: "a", status: "out", summary: null, reason: null, picked: false }] });
    const { container } = render(<ScoutsPanel card={makeCard({ status: "running", stalledIn: null, scouts: 1 })} onChanged={() => {}} />);
    await screen.findByRole("button", { name: "Scouts: 1" });
    expect(container.textContent).toBe("Scouts: 1▾");
    expect(container.querySelector(".w-full")).toBeNull();
  });

  it.each(["ready", "review", "merged"] as const)("has no send button on a %s ticket", (status) => {
    serve({ why: null, scouts: [] });
    render(<ScoutsPanel card={makeCard({ status, stalledIn: null })} onChanged={() => {}} />);
    expect(screen.queryByRole("button", { name: /^Scouts:/ })).toBeNull();
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

    expect(screen.getByText("Scouts: 2")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Scouts:/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Scout details" }));
    expect(await screen.findByText("S1 is smallest.")).toBeTruthy();
    expect(screen.getByText("Kept")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep this one" }));
    await waitFor(() => expect(posts).toEqual([{ action: "swap", ticketId: card.id, scoutId: "s2" }]));
  });

  it("shows nothing on a ticket in To Do without scouts", () => {
    serve({ why: null, scouts: [] });
    const { container } = render(<ScoutsPanel card={makeCard({ status: "ready", stalledIn: null })} onChanged={() => {}} />);
    expect(container.innerHTML).toBe("");
  });
});
