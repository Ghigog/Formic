"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { BoardCard } from "@/lib/domain/entities";
import { columnOf } from "@/lib/domain/status";
import {
  BUG_COST,
  COLOR_UNLOCKS,
  heatStacks,
  isBug,
  mergePoints,
  multiplierOf,
  pointsOf,
  scoreOf,
  SHAPE_UNLOCKS,
  unlocksAt,
  rankOf,
  epicBonus,
  type BugColor,
  type BugShape,
  type Score,
} from "@/lib/colony/game";
import type { ExtrasMap } from "@/components/board/card";
import { ColonyFx, cardEl, centerOf, colonyEl, type CrewPhase } from "./fx";
import { SoundEngine, type Sfx } from "./sound";
import { useHydrated, useSaved } from "./store";

/**
 * The colony layer over the board: score, level, heat, sound and the canvas
 * effects. It watches the cards rather than being told what happened, so a
 * merge an agent made lands the same way as one a person dragged.
 *
 * Everything here is optional to the board: without a provider the board
 * renders plain, which is how its tests see it.
 */

export interface EpicWin {
  epic: BoardCard;
  tickets: number;
  bonus: number;
}

export interface ColonyApi {
  cards: BoardCard[];
  extras: ExtrasMap;
  score: Score;
  /** Points on the counter: the score less whatever is still in flight to it. */
  shownPoints: number;
  /** Live heat stacks, as expiry times. */
  stacks: number[];
  multiplier: number;
  shape: BugShape;
  color: BugColor;
  bugHex: string;
  sound: boolean;
  setSound: (on: boolean) => void;
  /** Equips a style, or refuses one the level has not reached. */
  tryStyle: (patch: { shape?: BugShape; color?: BugColor }, from: HTMLElement) => void;
  timelineOpen: boolean;
  setTimelineOpen: (open: boolean) => void;
  colonyOpen: boolean;
  setColonyOpen: (open: boolean) => void;
  toast: { text: string; key: number } | null;
  win: EpicWin | null;
  closeWin: () => void;
  sfx: (n: Sfx, v?: number) => void;
  fx: ColonyFx;
  /** Epoch ms, a second at a time: what the heat bars are measured against. */
  now: number;
  /** A refused move: says why, over the card. */
  reject: (cardId: string, reason: string) => void;
}

const Ctx = createContext<ColonyApi | null>(null);

export function useColony(): ColonyApi | null {
  return useContext(Ctx);
}

/** What a card's ant crew should be doing, if it has one. */
function crewPhase(card: BoardCard, extras: ExtrasMap): CrewPhase | null {
  if (card.kind !== "ticket") return null;
  if (card.status === "running") return "work";
  if (card.status === "review") return extras[card.id]?.ci === "passing" ? "buried" : "tunnel";
  return null;
}

export function ColonyProvider({
  storageKey,
  cards,
  extras,
  children,
}: {
  /** One colony per board. */
  storageKey: string;
  cards: BoardCard[];
  extras: ExtrasMap;
  children: React.ReactNode;
}) {
  const [saved, setSaved] = useSaved(storageKey);
  const loaded = useHydrated();

  const [now, setNow] = useState(() => Date.now());
  /**
   * Merges whose points have reached the counter. A merge not in here yet
   * is still flying to it, so the counter holds those points back. Null
   * until the board is first seen: everything merged then has landed.
   */
  const [landed, setLanded] = useState<ReadonlySet<string> | null>(null);
  /** Merges with a reaction on its way. */
  const flying = useRef(new Set<string>());
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [colonyOpen, setColonyOpen] = useState(false);
  const [toast, setToast] = useState<ColonyApi["toast"]>(null);
  const [win, setWin] = useState<EpicWin | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  const score = useMemo(() => scoreOf(cards), [cards]);
  const stacks = useMemo(() => heatStacks(cards, now), [cards, now]);
  const held = useMemo(() => {
    if (!landed) return 0;
    let n = 0;
    for (const c of cards) {
      if (c.status !== "merged" || landed.has(c.id)) continue;
      n += c.kind === "ticket" ? mergePoints(c) : epicBonus(c, cards);
    }
    return n;
  }, [cards, landed]);
  const bugHex = COLOR_UNLOCKS.find((c) => c.key === saved.color)?.hex ?? COLOR_UNLOCKS[0]!.hex;

  const [sound] = useState(() => new SoundEngine());
  const [fx] = useState(() => new ColonyFx(sound));
  const sfx = useCallback((n: Sfx, v = 0) => sound.play(n, v), [sound]);

  // What the frame loop draws from, pushed in whenever it changes.
  const crews = useMemo(() => {
    const out = new Map<string, { phase: CrewPhase; sp: number }>();
    for (const c of cards) {
      const phase = crewPhase(c, extras);
      if (phase) out.set(c.id, { phase, sp: pointsOf(c) });
    }
    return out;
  }, [cards, extras]);
  useEffect(() => {
    fx.setWorld({
      crews,
      level: score.level,
      ants: "busy",
      full: true,
      bugShape: saved.shape,
      bugHex,
      covered: timelineOpen,
    });
  }, [fx, crews, score.level, saved.shape, bugHex, timelineOpen]);
  useEffect(() => sound.setEnabled(saved.sound), [sound, saved.sound]);
  useEffect(() => sound.attach(), [sound]);
  useEffect(() => {
    const canvas = canvasRef.current;
    return canvas ? fx.mount(canvas) : undefined;
  }, [fx]);

  // Heat decays a stack at a time; a second's resolution is plenty.
  const lastCount = useRef(0);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (stacks.length < lastCount.current) sfx("decay");
    lastCount.current = stacks.length;
  }, [stacks.length, sfx]);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((text: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, key: Date.now() });
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  /* ------------------------------------------------------------ levels */

  const prevLevel = useRef<number | null>(null);
  useEffect(() => {
    if (!loaded) return;
    const was = prevLevel.current;
    prevLevel.current = score.level;
    if (was === null || score.level <= was) return;
    const lv = score.level;
    const t = setTimeout(() => {
      sfx("level");
      const b = colonyEl("level");
      if (b) {
        if (!fx.reducedMotion) {
          b.animate(
            [
              { transform: "rotateY(0) scale(1)" },
              { transform: "rotateY(360deg) scale(1.3)" },
              { transform: "rotateY(360deg) scale(1)" },
            ],
            { duration: 700, easing: "cubic-bezier(.2,.8,.2,1)" },
          );
        }
        const [x, y] = centerOf(b);
        fx.ring(x, y, "var(--clay)", 60, 0.6, 2.5);
        fx.burst(x, y, ["var(--clay)", "var(--clay-lit)", "var(--text)"], 18, { speed: 240, size: 3 });
      }
      const got = unlocksAt(lv);
      showToast(
        got.length
          ? `Lv ${lv} ${rankOf(lv)} · unlocked ${got.join(" and ")}. Tap the nest to equip`
          : `Lv ${lv} ${rankOf(lv)} reached`,
      );
      const nest = colonyEl("nest");
      if (got.length && nest) {
        const [x, y] = centerOf(nest);
        fx.ring(x, y, "var(--clay-lit)", 40, 0.8, 2);
      }
    }, 380);
    return () => clearTimeout(t);
  }, [score.level, loaded, fx, sfx, showToast]);

  /* --------------------------------------------------------- reactions */

  const prev = useRef<Map<string, { status: string; col: string }> | null>(null);
  const prevCi = useRef<Record<string, string | undefined>>({});
  const savedRef = useRef(saved);
  useEffect(() => {
    savedRef.current = saved;
  });

  useEffect(() => {
    if (!loaded) return;
    const before = prev.current;
    prev.current = new Map(cards.map((c) => [c.id, { status: c.status, col: columnOf(c) }]));
    const ciBefore = prevCi.current;
    prevCi.current = Object.fromEntries(Object.entries(extras).map(([k, v]) => [k, v?.ci]));
    const mergedIds = cards.filter((c) => c.status === "merged").map((c) => c.id);
    // First sight of the board: nothing "happened", it just is.
    if (!before) {
      setLanded(new Set(mergedIds));
      return;
    }

    const later: Array<() => void> = [];

    for (const card of cards) {
      const was = before.get(card.id);
      const col = columnOf(card);

      if (!was) {
        if (isBug(card) && col === "backlog") later.push(() => penalty(card));
        continue;
      }
      if (was.status === card.status) continue;

      later.push(() => landed(card));
      if (card.kind === "ticket" && card.status === "merged") {
        flying.current.add(card.id);
        const heat = heatStacks(cards, Date.now()).length;
        later.push(() => merged(card, mergePoints(card), card.mergeMultiplier ?? 1, heat));
      } else if (card.kind === "epic" && card.status === "merged") {
        flying.current.add(card.id);
        later.push(() => epicMerged(card, epicBonus(card, cards)));
      } else if (card.status === "running") {
        later.push(() => dispatched(card));
      } else if (card.status === "review") {
        later.push(() => fx.mark(el(card) ?? document.body, card.prNumber ? `PR #${card.prNumber} OPENED` : "PR OPENED", "Reviewer Agent"));
      } else if (was.status === "waiting" && card.status === "ready") {
        later.push(() => unlocked(card));
      } else if (card.kind === "epic" && card.status === "specified") {
        later.push(() => mark(card, "PRD DRAFTED", "Product Agent", "var(--terracotta-deep)"));
      } else if (card.status === "failed" || card.status === "blocked") {
        later.push(() => {
          sfx("reject");
          mark(card, "NEEDS YOU", card.blockedReason ?? null, "var(--crimson)");
        });
      }
      if (isBug(card) && was.col === "backlog" && col !== "backlog") later.push(() => squashBug(card));
    }

    for (const card of cards) {
      const a = ciBefore[card.id];
      const b = extras[card.id]?.ci;
      if (a === b || !b || !a) continue;
      if (b === "passing") later.push(() => ciPassed(card));
      if (b === "failing") later.push(() => mark(card, "CHECKS FAILED", "fix loop running", "var(--crimson)"));
    }

    // Merged with nothing to show for it (it arrived merged, say): count it now.
    const quiet = mergedIds.filter((id) => !flying.current.has(id));
    if (quiet.length) setLanded((s) => new Set([...(s ?? []), ...quiet]));
    if (!later.length) return;
    // After the browser lays the moved cards out in their new columns. Not
    // cancelled on the next change: \`prev\` has already moved on, so a
    // reaction dropped here would never fire.
    requestAnimationFrame(() => later.forEach((f) => f()));

    /* The individual reactions. Each finds its card where it now sits. */

    function el(card: BoardCard) {
      return cardEl(card.id);
    }
    function mark(card: BoardCard, text: string, sub: string | null, color?: string) {
      const e = el(card);
      if (e) fx.mark(e, text, sub, color);
    }
    function landed(card: BoardCard) {
      const e = el(card);
      if (!e) return;
      sfx("drop");
      fx.squish(e);
      const r = e.getBoundingClientRect();
      fx.burst(r.left + r.width / 2, r.bottom, ["var(--border-dashed)", "var(--border)", "var(--dot-idle)"], 10, {
        angle: -Math.PI / 2,
        spread: Math.PI * 0.9,
        speed: 120,
        g: 300,
        size: 1.8,
        life: 0.5,
        shape: "dot",
      });
    }
    function release(id: string) {
      flying.current.delete(id);
      setLanded((s) => new Set([...(s ?? []), id]));
      const s = colonyEl("score");
      if (s && !fx.reducedMotion) {
        s.animate(
          [{ transform: "scale(1)" }, { transform: "scale(1.28)", color: "var(--terracotta-cta)" }, { transform: "scale(1)" }],
          { duration: 380, easing: "ease-out" },
        );
      }
    }
    function merged(card: BoardCard, pts: number, mult: number, stackCount: number) {
      const e = el(card) ?? colonyEl("board");
      if (!e) return release(card.id);
      const [cx, cy, r] = centerOf(e);
      setTimeout(() => sfx("ding"), 40);
      fx.shake(2);
      fx.ring(cx, cy, "var(--jade)", 100, 0.6, 3);
      fx.burst(cx, cy, ["var(--jade)", "var(--terracotta)", "var(--clay)", "var(--text)"], 26, { speed: 300, size: 3.2 });
      fx.pop(cx, r.top + 4, `+${pts}`, `MERGED · ${pointsOf(card)} SP × ${mult.toFixed(1)}`, "var(--terracotta-cta)", 22);
      const heat = colonyEl("heat");
      if (heat && !fx.reducedMotion) {
        heat.animate(
          [
            { transform: "scale(1)" },
            { transform: "scale(1.4) rotate(-8deg)" },
            { transform: "scale(0.94) rotate(3deg)" },
            { transform: "none" },
          ],
          { duration: 420, easing: "ease-out" },
        );
      }
      sfx("mult", stackCount - 1);
      const s = colonyEl("score");
      if (!s || !s.getBoundingClientRect().width) return release(card.id);
      const [sx, sy] = centerOf(s);
      let got = false;
      fx.fly(cx, r.top + 10, sx, sy, 6, "var(--terracotta)", (i) => {
        sfx("blip", i * 2 + stackCount * 3);
        if (!got) {
          got = true;
          release(card.id);
        }
      });
      const tl = colonyEl("timeline");
      if (tl && card.epicId && tl.getBoundingClientRect().width) {
        const [ex, ey] = centerOf(tl);
        fx.fly(cx, r.top, ex, ey, 3, "var(--text)", (i) => {
          if (i === 0) {
            tl.animate([{ transform: "none" }, { transform: "scale(1.08)" }, { transform: "none" }], {
              duration: 320,
              easing: "cubic-bezier(.2,.9,.3,1.4)",
            });
            fx.ring(ex, ey, "var(--clay)", 50, 0.45);
          }
          sfx("blip", 12 + i * 3);
        });
      }
    }
    function epicMerged(epic: BoardCard, bonus: number) {
      setTimeout(() => {
        sfx("epic");
        setWin({ epic, tickets: epic.childCount, bonus });
        setTimeout(() => {
          fx.shake(3);
          release(epic.id);
        }, 720);
      }, 900);
    }
    function dispatched(card: BoardCard) {
      const e = el(card);
      if (!e) return;
      const [cx, cy] = centerOf(e);
      sfx("mint");
      fx.ring(cx, cy, "var(--clay)", 70, 0.5);
      if (!isBug(card)) fx.mark(e, "AGENT DISPATCHED", card.model ?? null, "var(--terracotta-deep)");
    }
    function unlocked(card: BoardCard) {
      const e = el(card);
      if (!e) return;
      const [x, y, r] = centerOf(e);
      sfx("unlock");
      fx.ring(x, y, "var(--jade)", 80, 0.6, 2.5);
      fx.pop(x, r.top, "UNLOCKED", `${card.key} ready to run`, "var(--jade)", 16);
      e.animate(
        [
          { boxShadow: "0 0 0 0 color-mix(in srgb, var(--jade) 55%, transparent)" },
          { boxShadow: "0 0 0 10px color-mix(in srgb, var(--jade) 0%, transparent)" },
        ],
        { duration: 900, easing: "ease-out" },
      );
    }
    function ciPassed(card: BoardCard) {
      const e = el(card);
      if (!e) return;
      const [x, y, r] = centerOf(e);
      sfx("green");
      fx.ring(x, y, "var(--jade)", 60, 0.5);
      fx.pop(x, r.top, "CI PASSED", "ready to merge", "var(--jade)", 15);
    }
    function penalty(card: BoardCard) {
      const e = el(card);
      if (!e) return;
      const [cx, , r] = centerOf(e);
      sfx("bad");
      fx.pop(cx, r.top + 4, `−${BUG_COST}`, "BUG REPORTED", "var(--crimson)", 20);
      const s = colonyEl("score");
      if (s && s.getBoundingClientRect().width) {
        const [sx, sy] = centerOf(s);
        fx.fly(sx, sy, cx, r.top + 10, 4, "var(--crimson)", (i) => {
          if (i === 0) fx.ring(cx, r.top + 10, "var(--crimson)", 36, 0.35);
        });
        if (!fx.reducedMotion) {
          s.animate(
            [
              { transform: "none", color: "var(--crimson)" },
              { transform: "translateX(-5px)", color: "var(--crimson)" },
              { transform: "translateX(4px)", color: "var(--crimson)" },
              { transform: "none" },
            ],
            { duration: 420 },
          );
        }
      }
    }
    function squashBug(card: BoardCard) {
      const e = el(card);
      if (!e) return;
      const icon = e.querySelector("[data-bugicon]") ?? e;
      const [x, y] = centerOf(icon);
      const first = score.squashed === 1;
      fx.squash(x, y - 2, () => {
        sfx("squash");
        fx.shake(5);
        fx.ring(x, y, "var(--crimson)", 56, 0.4, 3);
        fx.ring(x, y, "var(--text)", 26, 0.25, 1.5);
        fx.burst(x, y, [fx.bugHex, "var(--crimson)", "var(--text)"], 16, {
          speed: 200,
          g: 600,
          size: 2.2,
          life: 0.6,
          shape: "dot",
        });
        fx.pop(x + 20, y - 16, "SQUASHED", null, "var(--crimson)", 15);
        setTimeout(() => fx.carriers(x, y, 2, fx.bugHex), 700);
        if (first) setTimeout(() => showToast("First bug squashed"), 1100);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, extras, loaded]);

  const reject = useCallback(
    (cardId: string, reason: string) => {
      sfx("reject");
      const e = cardEl(cardId);
      if (!e) return;
      fx.mark(e, reason, null, "var(--crimson)", 13);
      if (!fx.reducedMotion) {
        e.animate(
          [
            { transform: "translateX(0)" },
            { transform: "translateX(-7px)" },
            { transform: "translateX(6px)" },
            { transform: "translateX(-3px)" },
            { transform: "none" },
          ],
          { duration: 280 },
        );
      }
    },
    [fx, sfx],
  );

  const tryStyle = useCallback<ColonyApi["tryStyle"]>(
    (patch, from) => {
      const lv = score.level;
      const need = patch.shape
        ? (SHAPE_UNLOCKS.find((u) => u.key === patch.shape)?.lv ?? 1)
        : (COLOR_UNLOCKS.find((u) => u.key === patch.color)?.lv ?? 1);
      if (lv < need) {
        sfx("reject");
        from.animate(
          [{ transform: "none" }, { transform: "translateX(-4px)" }, { transform: "translateX(3px)" }, { transform: "none" }],
          { duration: 240 },
        );
        return;
      }
      setSaved((s) => ({ ...s, ...patch }));
      // A test squash in the new style, on the button that chose it.
      requestAnimationFrame(() => {
        const [x, y] = centerOf(from);
        fx.squash(
          x,
          y - 6,
          () => {
            sfx("squash");
            fx.ring(x, y - 6, "var(--crimson)", 36, 0.35, 2);
            fx.burst(x, y - 6, [fx.bugHex, "var(--text)"], 10, { speed: 150, size: 2, life: 0.5, shape: "dot" });
          },
          7,
        );
      });
    },
    [fx, sfx, score.level, setSaved],
  );

  const api: ColonyApi = {
    cards,
    extras,
    score,
    shownPoints: Math.max(0, score.points - held),
    stacks,
    multiplier: multiplierOf(stacks.length),
    shape: saved.shape,
    color: saved.color,
    bugHex,
    sound: saved.sound,
    setSound: (on) => {
      setSaved((s) => ({ ...s, sound: on }));
      sound.setEnabled(on);
      if (on) sfx("ready");
    },
    tryStyle,
    timelineOpen,
    setTimelineOpen: (open) => {
      sfx(open ? "pickup" : "drop");
      setTimelineOpen(open);
      if (open) setColonyOpen(false);
    },
    colonyOpen,
    setColonyOpen: (open) => {
      sfx(open ? "pickup" : "drop");
      setColonyOpen(open);
    },
    toast,
    win,
    closeWin: () => setWin(null),
    sfx,
    fx,
    now,
    reject,
  };

  return (
    <Ctx.Provider value={api}>
      {children}
      {/* Over the board, under every drawer and dialog (z-50 and up), so
          an open card is never crawled over by the ants behind it. */}
      <canvas
        ref={canvasRef}
        aria-hidden
        className="pointer-events-none fixed inset-0 z-[45] h-full w-full"
      />
    </Ctx.Provider>
  );
}
