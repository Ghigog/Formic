import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installMatchMedia, setViewportMatches, resetViewport } from "@/test/viewport";
import type { PlaytestApi } from "./playtest-context";
import type { PlaytestMessage, PlaytestSession } from "./types";

const m = vi.hoisted(() => ({ api: null as PlaytestApi | null }));
vi.mock("./playtest-context", () => ({ usePlaytest: () => m.api }));
vi.mock("@/components/onboarding/tour", () => ({ AutoTour: () => null }));

const { PlaytestScreen, ASK_AFTER_MS } = await import("./playtest-screen");

const base: PlaytestSession = {
  id: "pt1",
  status: "live",
  stage: null,
  kind: "static",
  url: "https://8484-sb.e2b.app",
  commitSha: "abc1234def",
  error: null,
  logTail: [],
  startedAt: "2026-11-19T00:00:00Z",
  endsAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  endedAt: null,
  endReason: null,
  summary: null,
  newer: false,
};

let messages: PlaytestMessage[] = [];
let requests: Array<{ url: string; method: string; body?: unknown }> = [];

function api(session: PlaytestSession | null, over: Partial<PlaytestApi> = {}): PlaytestApi {
  return {
    access: { ok: true },
    session,
    screenOpen: true,
    open: vi.fn(),
    close: vi.fn(),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    setSession: vi.fn(),
    startError: null,
    repoName: "game",
    projectId: "p1",
    ...over,
  };
}

beforeEach(() => {
  installMatchMedia();
  setViewportMatches(true);
  messages = [];
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({ url, method, body });
      if (url.endsWith("/notes")) {
        const note: PlaytestMessage = { id: `n${requests.length}`, role: "user", content: body.text, status: "done", proposals: [], shots: [], createdAt: "2026-11-19T00:00:00Z" };
        return Response.json({ message: note }, { status: 201 });
      }
      if (url === "/api/playtest/sessions") {
        return Response.json({
          sessions: [{ ...base, id: "old", status: "ended", mine: false, by: "Ada", notes: 2, summary: "2 notes." }],
        });
      }
      if (url === "/api/playtest/old") {
        return Response.json({
          session: { ...base, id: "old", status: "ended" },
          messages: [{ id: "x", role: "user", content: "Old note", status: "done", proposals: [], shots: [], createdAt: "2026-11-18T00:00:00Z" }],
        });
      }
      if (url.startsWith("/api/playtest/")) return Response.json({ session: m.api?.session, messages });
      return Response.json({});
    }),
  );
});

afterEach(() => {
  cleanup();
  resetViewport();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PlaytestScreen", () => {
  it("shows the product in a frame with the build, the time left and a public-link warning", async () => {
    m.api = api(base);
    render(<PlaytestScreen />);
    const frame = screen.getByTitle("game, playtest") as HTMLIFrameElement;
    expect(frame.src).toBe("https://8484-sb.e2b.app/");
    expect(screen.getByText(/abc1234 · \d+:\d\d left/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open in new tab/ }).getAttribute("title")).toMatch(/Anyone with this link/);
  });

  it("shows where a starting session is, and its log", () => {
    m.api = api({ ...base, status: "starting", url: null, stage: "install:Godot game", logTail: ["Downloading the Web export templates..."] });
    render(<PlaytestScreen />);
    expect(screen.getByText("Playtest · Godot game")).toBeTruthy();
    expect(screen.getByText(/Installing…/)).toBeTruthy();
    expect(screen.getByText(/Downloading the Web export templates/)).toBeTruthy();
    expect(screen.queryByTitle(/playtest$/)).toBeNull();
  });

  it("explains a failed start, and can ask the PM for a fix with the log", async () => {
    m.api = api({ ...base, status: "failed", url: null, error: "Playtest runs web apps and Godot games for now.", logTail: ["npm ERR! missing script"] });
    render(<PlaytestScreen />);
    expect(screen.getByText("It did not start.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ask an agent to fix it" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Asked the PM" })).toBeTruthy());
    const note = requests.find((r) => r.url.endsWith("/notes"))!;
    expect((note.body as { text: string }).text).toContain("npm ERR! missing script");
  });

  it("sums up an ended session and offers to play again", async () => {
    m.api = api({ ...base, status: "ended", url: null, endReason: "time", summary: "3 notes, 1 ticket proposed." });
    render(<PlaytestScreen />);
    expect(screen.getByText("Out of time")).toBeTruthy();
    expect(screen.getByText("3 notes, 1 ticket proposed.")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /Play again/ })[0]!);
    await waitFor(() => expect(m.api!.start).toHaveBeenCalled());
  });

  it("sends a note on Enter, keeps Shift+Enter for a new line, and asks the PM once the person pauses", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    m.api = api(base);
    render(<PlaytestScreen />);
    const box = screen.getByLabelText(/Write a note for the PM/);
    fireEvent.change(box, { target: { value: "The jump is late" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(requests.some((r) => r.url.endsWith("/notes"))).toBe(false);
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(screen.getByText("The jump is late")).toBeTruthy());
    expect(requests.find((r) => r.url.endsWith("/notes"))!.body).toEqual({ text: "The jump is late", shots: [] });
    expect(requests.some((r) => r.url.endsWith("/ask"))).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ASK_AFTER_MS + 50);
    });
    expect(requests.filter((r) => r.url.endsWith("/ask"))).toHaveLength(1);
  });

  it("stops the session, asking about any notes first", async () => {
    m.api = api(base);
    render(<PlaytestScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Stop the playtest" }));
    await waitFor(() => expect(m.api!.stop).toHaveBeenCalled());
  });

  it("makes Restart glow when newer work has merged", () => {
    m.api = api({ ...base, newer: true });
    render(<PlaytestScreen />);
    expect(screen.getByRole("button", { name: /Restart/ }).className).toContain("glow-ready");
  });

  it("lists past sessions and opens one read-only", async () => {
    m.api = api(base);
    render(<PlaytestScreen />);
    fireEvent.click(screen.getByRole("button", { name: /Sessions/ }));
    const row = await screen.findByText(/Ada · abc1234 · 2 notes/);
    fireEvent.click(row);
    await waitFor(() => expect(screen.getByText("Old note")).toBeTruthy());
    expect(screen.queryByLabelText(/Write a note for the PM/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to this playtest" }));
    expect(screen.getByLabelText(/Write a note for the PM/)).toBeTruthy();
  });

  it("shows the PM's reply with its proposal and decides it", async () => {
    messages = [
      { id: "n1", role: "user", content: "Score never resets", status: "done", proposals: [], shots: [{ id: "a1", url: "/api/attachments/a1" }], createdAt: "2026-11-19T00:00:00Z" },
      {
        id: "r1",
        role: "assistant",
        content: "**Worth a ticket**: the score.",
        status: "done",
        proposals: [{ summary: "Reset the score", action: { type: "create_backlog_item" }, state: "proposed" }] as PlaytestMessage["proposals"],
        shots: [],
        createdAt: "2026-11-19T00:00:01Z",
      },
    ];
    m.api = api(base);
    render(<PlaytestScreen />);
    await waitFor(() => expect(screen.getByText("Reset the score")).toBeTruthy());
    expect(screen.getByAltText("Screenshot").getAttribute("src")).toBe("/api/attachments/a1");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(requests.some((r) => r.url === "/api/assistant/proposals")).toBe(true));
    expect(requests.find((r) => r.url === "/api/assistant/proposals")!.body).toEqual({ messageId: "r1", index: 0, decision: "apply" });
  });

  it("closes on Escape, and on a phone keeps the notes in a sheet", () => {
    m.api = api(base);
    const first = render(<PlaytestScreen />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(m.api.close).toHaveBeenCalled();
    first.unmount();

    setViewportMatches(false);
    render(<PlaytestScreen />);
    expect(screen.queryByLabelText(/Write a note for the PM/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Notes/ }));
    expect(screen.getByLabelText(/Write a note for the PM/)).toBeTruthy();
  });

  it("offers a screenshot only once the helper in the frame says hello, and drags out a region", async () => {
    m.api = api(base);
    setViewportMatches(false); // a phone: no tab-capture fallback
    render(<PlaytestScreen />);
    expect(screen.queryByRole("button", { name: /Screenshot/ })).toBeNull();
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { origin: "https://8484-sb.e2b.app", data: { type: "formic:hello" } }));
    });
    const shot = screen.getByRole("button", { name: /Screenshot/ });
    fireEvent.click(shot);
    const layer = screen.getByRole("application", { name: /Drag across the part/ });
    expect(screen.getByText("Drag across the part you mean")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("application")).toBeNull();
    expect(layer).toBeTruthy();
  });

  it("explains a start that was refused", async () => {
    m.api = api(null, { startError: "Playtest runs in an E2B sandbox on your own key." });
    render(<PlaytestScreen />);
    expect(screen.getByText("Playtest runs in an E2B sandbox on your own key.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(m.api!.start).toHaveBeenCalled());
  });
});
