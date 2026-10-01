import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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

async function open() {
  render(
    <ColonyProvider storageKey="colony-test-sentinels" cards={[]} extras={{}}>
      <SentinelsProvider initial={states([SENTINELS[0]!.id, SENTINELS[3]!.id])} level={13}>
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
