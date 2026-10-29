export type SwapDirection = "down" | "up";

export type SwapStep<T> = { kind: "board"; target: T } | { kind: "end" };

/** A run of swaps: the board order frozen when it began, and where the person is in it. */
export interface SwapStreak<T> {
  step(direction: SwapDirection): SwapStep<T>;
  end(): void;
  readonly active: boolean;
}

/**
 * Start a streak on `current`. Down moves to the next board, up to the previous
 * one; neither wraps, so the ends answer with `end` and stay put.
 */
export function startStreak<T>(order: readonly T[], current: T): SwapStreak<T> {
  const frozen = [...order];
  let index = frozen.indexOf(current);
  let active = index >= 0;
  return {
    step(direction) {
      const next = index + (direction === "down" ? 1 : -1);
      if (!active || next < 0 || next >= frozen.length) return { kind: "end" };
      index = next;
      return { kind: "board", target: frozen[next]! };
    },
    end() {
      active = false;
    },
    get active() {
      return active;
    },
  };
}
