import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ColonyProvider, useColony } from "@/components/colony/colony";
import { ColonyFx } from "@/components/colony/fx";
import { SoundEngine } from "@/components/colony/sound";
import { SENTINELS } from "@/lib/sentinels/roster";
import type { SentinelStates } from "@/lib/sentinels/view";
import { SentinelsPage } from "./sentinels";
import { SentinelsProvider } from "./store";

const states = (reported: string[]): SentinelStates =>
  Object.fromEntries(
    SENTINELS.map((x) => [
      x.id,
      {
        id: x.id,
        stars: reported.includes(x.id) ? 4 : null,
        quote: null,
        summary: null,
        report: null,
        at: reported.includes(x.id) ? new Date().toISOString() : null,
        model: null,
        files: [],
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

describe("SentinelsPage locked sentinels", () => {
  const card = (id: string) => document.querySelector(`[data-card="${id}"]`) as HTMLElement;
  const locked = SENTINELS.find((x) => x.unlockLevel > 1)!;
  const first = SENTINELS.find((x) => x.unlockLevel === 1)!;

  it("shows a locked sentinel's unlock level and no run button", async () => {
    await open(1);
    expect(within(card(locked.id)).getByText(`Unlocks at Lv ${locked.unlockLevel}`)).toBeTruthy();
    expect(within(card(locked.id)).queryByRole("button")).toBeNull();
    expect(within(card(first.id)).getByRole("button", { name: /summon|re-run/i })).toBeTruthy();
  });

  it("offers a summon button once the colony reaches the unlock level", async () => {
    await open(locked.unlockLevel);
    expect(within(card(locked.id)).queryByText(/Unlocks at Lv/)).toBeNull();
    expect(within(card(locked.id)).getByRole("button", { name: /summon/i })).toBeTruthy();
  });
});

describe("Report: create epic", () => {
  const x = SENTINELS[0]!;
  const report = { likes: [], dislikes: [], wrong: [{ text: "Bug", ref: "a.ts" }], missing: [] };

  async function openWith(stars: number, running = false) {
    const base = states([]);
    base[x.id] = {
      ...base[x.id]!,
      stars,
      summary: "Summary",
      report,
      at: new Date().toISOString(),
      running: running ? { log: [], startedAt: new Date().toISOString() } : null,
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
    return screen.getByRole("button", { name: "Create epic from this report" });
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
