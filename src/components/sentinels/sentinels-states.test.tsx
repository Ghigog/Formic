import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ColonyProvider, useColony } from "@/components/colony/colony";
import { SENTINELS } from "@/lib/sentinels/roster";
import type { SentinelState, SentinelStates } from "@/lib/sentinels/view";
import { SentinelsPage } from "./sentinels";
import { SentinelsProvider } from "./store";

/** How a card reads for each state a sentinel can be in: reported long ago, running, failed. */

const RUBRIC = {
  context: "A board.",
  rungs: [2, 3, 4, 5].map((stars) => ({ stars, checks: [{ id: `${stars}a`, text: `Bar ${stars}.`, how: "Read it." }] })),
};

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;

function blank(id: string): SentinelState {
  return {
    id,
    auditId: null,
    epicId: null,
    stars: null,
    quote: null,
    summary: null,
    report: null,
    scoredWith: null,
    at: null,
    model: null,
    files: [],
    rubric: null,
    rubricChanged: false,
    running: null,
    error: null,
  };
}

function reported(id: string, at: string, extra: Partial<SentinelState> = {}): SentinelState {
  return { ...blank(id), stars: 4, at, scoredWith: RUBRIC, rubric: { rubric: RUBRIC, at, model: null }, ...extra };
}

function Open() {
  const c = useColony();
  return <button onClick={() => c?.setSentinelsOpen(true)}>open sentinels</button>;
}

beforeEach(() => {
  HTMLElement.prototype.animate = vi.fn() as never;
  SVGElement.prototype.animate = vi.fn() as never;
});
afterEach(() => {
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
  delete (SVGElement.prototype as { animate?: unknown }).animate;
});

describe("SentinelsPage card states", () => {
  it("dates each report, and shows a run in progress, a failed run and a stale rubric", async () => {
    const [a, b, c, d, e, f, g] = SENTINELS.map((x) => x.id);
    const states: SentinelStates = Object.fromEntries(SENTINELS.map((x) => [x.id, blank(x.id)]));
    states[a!] = reported(a!, ago(10_000));
    states[b!] = reported(b!, ago(5 * MIN));
    states[c!] = reported(c!, ago(3 * 60 * MIN));
    states[d!] = reported(d!, ago(3 * 24 * 60 * MIN), { rubricChanged: true });
    states[e!] = { ...blank(e!), running: { kind: "audit", log: ["Reading", "Scoring"], startedAt: ago(MIN) } };
    states[f!] = { ...blank(f!), running: { kind: "calibrate", log: [], startedAt: ago(MIN) } };
    states[g!] = { ...blank(g!), error: "The audit failed." };

    render(
      <ColonyProvider storageKey="colony-test-sentinel-states" cards={[]} extras={{}}>
        <SentinelsProvider initial={states} level={34}>
          <Open />
          <SentinelsPage repoName="repo" />
        </SentinelsProvider>
      </ColonyProvider>,
    );
    await userEvent.click(screen.getByText("open sentinels"));

    for (const text of [/just now/, /5m ago/, /3h ago/, /3d ago/]) {
      expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByTitle("The audit failed.").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Scoring|Waking up/).length).toBeGreaterThan(0);
  });
});
