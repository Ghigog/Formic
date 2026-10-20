import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ColonyProvider, useColony } from "@/components/colony/colony";
import { ColonyFx } from "@/components/colony/fx";
import { SoundEngine } from "@/components/colony/sound";
import { resetViewport, setViewportMatches } from "@/test/viewport";
import { SENTINELS } from "@/lib/sentinels/roster";
import type { SentinelStates } from "@/lib/sentinels/view";
import { SentinelsPage } from "./sentinels";
import { SentinelsProvider } from "./store";

const RUBRIC = {
  context: "A board.",
  rungs: [2, 3, 4, 5].map((stars) => ({ stars, checks: [{ id: `${stars}a`, text: `Bar ${stars}.`, how: "Read it." }] })),
};

const states = (reported: string[]): SentinelStates =>
  Object.fromEntries(
    SENTINELS.map((x) => [
      x.id,
      {
        id: x.id,
        auditId: null,
        epicId: null,
        stars: reported.includes(x.id) ? 4 : null,
        quote: null,
        summary: null,
        report: null,
        scoredWith: reported.includes(x.id) ? RUBRIC : null,
        at: reported.includes(x.id) ? new Date().toISOString() : null,
        model: null,
        files: [],
        rubric: reported.includes(x.id) ? { rubric: RUBRIC, at: null, model: null } : null,
        rubricChanged: false,
        running: null,
        error: null,
      },
    ]),
  );

function Open() {
  const c = useColony();
  return <button onClick={() => c?.setSentinelsOpen(true)}>open sentinels</button>;
}

async function open(level = 13) {
  render(
    <ColonyProvider storageKey="colony-test-sentinels" cards={[]} extras={{}}>
      <SentinelsProvider initial={states([SENTINELS[0]!.id, SENTINELS[3]!.id])} level={level}>
        <Open />
        <SentinelsPage repoName="repo" />
      </SentinelsProvider>
    </ColonyProvider>,
  );
  await userEvent.click(screen.getByText("open sentinels"));
}

describe("SentinelsPage motion and sound", () => {
  const animate = vi.fn();
  let play: ReturnType<typeof vi.spyOn>;
  let reduced: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    animate.mockReset();
    HTMLElement.prototype.animate = animate as unknown as HTMLElement["animate"];
    SVGElement.prototype.animate = animate as unknown as SVGElement["animate"];
    play = vi.spyOn(SoundEngine.prototype, "play").mockImplementation(() => {});
    reduced = vi.spyOn(ColonyFx.prototype, "reducedMotion", "get").mockReturnValue(false);
  });
  afterEach(() => vi.restoreAllMocks());

  const animated = () => animate.mock.contexts.map((el) => (el as HTMLElement).dataset.card);

  it("slides up only the cards that have reported", async () => {
    await open();
    expect(animated().sort()).toEqual([SENTINELS[0]!.id, SENTINELS[3]!.id].sort());
    expect(play).toHaveBeenCalledWith("sentinelsOpen", 0);
  });

  it("animates nothing under reduced motion", async () => {
    reduced.mockReturnValue(true);
    await open();
    expect(animate).not.toHaveBeenCalled();
    await userEvent.hover(screen.getAllByRole("listitem")[0]!);
    expect(animate).not.toHaveBeenCalled();
  });

  it("plays a hovered sentinel's voice, once for rapid hovers", async () => {
    await open();
    animate.mockClear();
    play.mockClear();
    const cards = screen.getAllByRole("listitem");
    await userEvent.hover(cards[2]!);
    await userEvent.hover(cards[3]!);
    expect(play.mock.calls.filter(([n]: unknown[]) => n === "sentinelVoice")).toEqual([["sentinelVoice", 2]]);
    expect(animate).toHaveBeenCalled();
  });
});

describe("SentinelsPage scroll lock", () => {
  it("locks background scroll while open and releases it on close", async () => {
    await open();
    expect(document.body.style.overflow).toBe("hidden");
    expect(screen.getByRole("region", { name: "Sentinels" })).toHaveClass("overscroll-none");
  });

  it("restores the previous overflow on unmount", async () => {
    document.body.style.overflow = "scroll";
    await open();
    expect(document.body.style.overflow).toBe("hidden");
    cleanup();
    expect(document.body.style.overflow).toBe("scroll");
    document.body.style.overflow = "";
  });
});

describe("SentinelsPage locked sentinels", () => {
  const card = (id: string) => document.querySelector(`[data-card="${id}"]`) as HTMLElement;
  const locked = SENTINELS.find((x) => x.unlockLevel > 1)!;
  const first = SENTINELS.find((x) => x.unlockLevel === 1)!;

  it("shows a locked sentinel's unlock level and no run button", async () => {
    await open(1);
    expect(within(card(locked.id)).getByText(`Unlocks at Lv ${locked.unlockLevel}`)).toBeTruthy();
    expect(within(card(locked.id)).queryByRole("button")).toBeNull();
    expect(within(card(first.id)).getByRole("button", { name: /calibrate|audit/i })).toBeTruthy();
  });

  it("offers a summon button once the colony reaches the unlock level", async () => {
    await open(locked.unlockLevel);
    expect(within(card(locked.id)).queryByText(/Unlocks at Lv/)).toBeNull();
    expect(within(card(locked.id)).getByRole("button", { name: "Calibrate" })).toBeTruthy();
  });
});

describe("Report: create epic", () => {
  const x = SENTINELS[0]!;
  const report = { likes: [], dislikes: [], wrong: [{ text: "Bug", ref: "a.ts" }], missing: [] };

  async function openWith(stars: number, running = false, epicId: string | null = null) {
    const base = states([]);
    base[x.id] = {
      ...base[x.id]!,
      stars,
      epicId,
      summary: "Summary",
      report,
      at: new Date().toISOString(),
      running: running ? { kind: "audit", log: [], startedAt: new Date().toISOString() } : null,
    };
    render(
      <ColonyProvider storageKey="colony-test-sentinels-epic" cards={[]} extras={{}}>
        <SentinelsProvider initial={base} level={13}>
          <Open />
          <SentinelsPage repoName="repo" />
        </SentinelsProvider>
      </ColonyProvider>,
    );
    await userEvent.click(screen.getByText("open sentinels"));
    await userEvent.click(document.querySelector(`[data-card="${x.id}"]`)!);
    return screen.getByRole("button", { name: epicId ? "Epic created" : "Create epic from this report" });
  }

  afterEach(() => vi.unstubAllGlobals());

  it("posts once and shows the epic is in Backlog", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ card: {} }) });
    vi.stubGlobal("fetch", fetchMock);
    const button = await openWith(3);
    await userEvent.click(button);
    expect(fetchMock).toHaveBeenCalledWith(`/api/sentinels/${x.id}/epic`, { method: "POST" });
    expect(await screen.findByText("Epic added to Backlog.")).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("reads Epic created and is disabled once the report has an epic", async () => {
    const button = await openWith(3, false, "epic-1");
    expect(button.textContent).toBe("Epic created");
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("is disabled at 5 stars", async () => {
    const button = await openWith(5);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("title")).toBeTruthy();
  });

  it("is disabled while an audit runs", async () => {
    const button = await openWith(3, true);
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("SentinelsPage carousel and report modal", () => {
  const scrollTo = vi.fn();
  const list = () => screen.getByRole("list", { name: "Sentinels" });
  const centred = () => screen.getAllByRole("listitem").findIndex((el) => el.getAttribute("aria-current") === "true");
  const card = (i: number) => screen.getAllByRole("listitem")[i]!;

  beforeEach(() => {
    scrollTo.mockReset();
    HTMLElement.prototype.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];
    vi.spyOn(SoundEngine.prototype, "play").mockImplementation(() => {});
    vi.spyOn(ColonyFx.prototype, "reducedMotion", "get").mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it("keeps only the badge, progress and summon-all above the carousel", async () => {
    await open();
    expect(screen.getByRole("button", { name: "Summon all 12" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sentinels" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Audit report" })).toBeNull();
    expect(screen.queryByText(/Twelve agents/)).toBeNull();
  });

  it("steps by one with the buttons and arrow keys, stopping at the ends", async () => {
    await open();
    expect(centred()).toBe(0);
    expect((screen.getByRole("button", { name: "Previous sentinel" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Next sentinel" }));
    expect(centred()).toBe(1);
    await userEvent.keyboard("{ArrowRight}");
    expect(centred()).toBe(2);
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}");
    expect(centred()).toBe(0);
    expect(scrollTo).toHaveBeenCalledTimes(4);
    for (let i = 0; i < SENTINELS.length + 2; i++) await userEvent.keyboard("{ArrowRight}");
    expect(centred()).toBe(SENTINELS.length - 1);
  });

  it("moves one step per wheel gesture and prevents the page scroll", async () => {
    await open();
    vi.useFakeTimers();
    try {
      const wheel = (deltaY: number) => {
        const e = new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true });
        act(() => void list().dispatchEvent(e));
        return e;
      };
      expect(wheel(40).defaultPrevented).toBe(true);
      wheel(60);
      wheel(30);
      expect(centred()).toBe(1);
      act(() => void vi.advanceTimersByTime(300));
      wheel(-40);
      expect(centred()).toBe(0);
      act(() => void vi.advanceTimersByTime(300));
      wheel(-40);
      expect(centred()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the wheel to the browser from md up", async () => {
    setViewportMatches(true);
    try {
      await open();
      const e = new WheelEvent("wheel", { deltaY: 40, bubbles: true, cancelable: true });
      act(() => void list().dispatchEvent(e));
      expect(e.defaultPrevented).toBe(false);
      expect(centred()).toBe(0);
    } finally {
      resetViewport();
    }
  });

  it("opens the report on the centred card and returns focus on close", async () => {
    await open();
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(card(0));
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(within(dialog).getByRole("complementary", { name: "Audit report" })).toBeTruthy();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(card(0));
    card(0).focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("a non-centred card scrolls to centre instead of opening", async () => {
    await open();
    await userEvent.click(card(2));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(centred()).toBe(2);
  });

  it("Escape closes the modal first, then the page", async () => {
    await open();
    await userEvent.click(card(0));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(card(0));
    expect(screen.getByRole("region", { name: "Sentinels" })).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Sentinels" })).toBeNull();
  });

  const post = (kind: string) => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind }),
  });

  it("Calibrate runs a calibration without opening the modal", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    await open();
    await userEvent.click(within(card(1)).getByRole("button", { name: "Calibrate" }));
    expect(fetchMock).toHaveBeenCalledWith(`/api/sentinels/${SENTINELS[1]!.id}`, post("calibrate"));
    expect(screen.queryByRole("dialog")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("Enter on the Re-audit button audits again and does not open the modal", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    await open();
    within(card(0)).getByRole("button", { name: "Re-audit" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(fetchMock).toHaveBeenCalledWith(`/api/sentinels/${SENTINELS[0]!.id}`, post("audit"));
    expect(screen.queryByRole("dialog")).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("SentinelsPage summary layout", () => {
  it("keeps the grade on the right of the stats on one row", async () => {
    await open();
    const grade = screen.getByTitle(/^Grade = average/);
    const stats = screen.getByText(/avg$/);
    expect(stats.compareDocumentPosition(grade) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const section = grade.closest("section")!;
    expect(section.className).not.toMatch(/flex-col/);
    expect(grade.parentElement!.className).not.toMatch(/flex-(col|wrap)/);
  });
});
