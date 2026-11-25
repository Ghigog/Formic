/** The PM's wake-up limits (docs/limits.md); enforced in src/lib/pm/wake-gate.ts. */
export const PM_WAKE_DEFAULTS = { fixCap: 2, perHour: 3, perDay: 10 } as const;
/**
 * Wake-ups across every board one person owns: their boards share one Claude
 * account, so per-board limits alone multiply with the number of boards.
 */
/**
 * The most times the PM is woken for one ticket's questions while its branch
 * stays where it is: an answer restarts the agent, which can ask again.
 */
export const PM_QUESTION_CAP = 2;

export const PM_ACCOUNT_WAKES = { perHour: 6, perDay: 20 } as const;
/** What a person may set each limit to. */
export const PM_WAKE_RANGE = { fixCap: [0, 10], perHour: [0, 60], perDay: [0, 500] } as const;

export type PmWakeLimits = { [K in keyof typeof PM_WAKE_DEFAULTS]: number };

/** A limit as set: null is the default. */
export type PmWakeLimitsSet = { [K in keyof PmWakeLimits]: number | null };

export function wakeLimits(set: PmWakeLimitsSet): PmWakeLimits {
  return {
    fixCap: set.fixCap ?? PM_WAKE_DEFAULTS.fixCap,
    perHour: set.perHour ?? PM_WAKE_DEFAULTS.perHour,
    perDay: set.perDay ?? PM_WAKE_DEFAULTS.perDay,
  };
}

/**
 * The PM's looks at one ticket since someone other than the PM last moved
 * its branch. Walking back from the newest: a look on the current head
 * counts; a commit the PM landed on that head links it to the head it was
 * fixing, whose looks count too; a look on any other head is where someone
 * else moved the branch, and the count stops there.
 */
export function fixAttempts(cardRecords: ReadonlyArray<{ kind: string; head: string }>, head: string): number {
  const ours = new Set([head]);
  let landedOnOurs = false;
  let count = 0;
  for (const r of [...cardRecords].reverse()) {
    if (r.kind === "landed") {
      if (ours.has(r.head)) landedOnOurs = true;
      continue;
    }
    if (r.kind !== "stall") continue;
    if (!ours.has(r.head)) {
      if (!landedOnOurs) break;
      ours.add(r.head);
    }
    landedOnOurs = false;
    count++;
  }
  return count;
}
