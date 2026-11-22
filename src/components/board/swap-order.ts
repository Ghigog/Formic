export type SwapDirection = "down" | "up";

export type SwapStep<T> = { kind: "board"; target: T } | { kind: "end" };

/**
 * Where swaps lead. "down" is the next board on the list, "up" goes back to the
 * board the person was just on: a stack of boards visited before the one in
 * view. It outlives a streak; the order passed in is the one frozen for it.
 */
export interface SwapHistory<T> {
  /** Where `direction` would lead from `current`, given the frozen `order`. Changes nothing. */
  target(direction: SwapDirection, order: readonly T[], current: T): SwapStep<T>;
  /** The person arrived by `direction` from `from`: next pushes it, back pops it. */
  arrived(direction: SwapDirection, from: T): void;
}

export function createSwapHistory<T>(): SwapHistory<T> {
  let stack: T[] | null = null;
  return {
    target(direction, order, current) {
      // Seeded once, from the order the boards were last opened in: the most recent on top.
      stack ??= order.filter((id) => id !== current).reverse();
      if (direction === "up") {
        const back = stack[stack.length - 1];
        return back === undefined ? { kind: "end" } : { kind: "board", target: back };
      }
      const index = order.indexOf(current);
      const next = index < 0 ? undefined : order[index + 1];
      return next === undefined ? { kind: "end" } : { kind: "board", target: next };
    },
    arrived(direction, from) {
      if (direction === "up") stack?.pop();
      else stack?.push(from);
    },
  };
}
