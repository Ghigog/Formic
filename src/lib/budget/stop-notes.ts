/**
 * What a run is told when a limit stops it: which limit, how it is enforced,
 * how to change it. Pure, so the controller and the coding loop say the same
 * thing. A stopped run stays retryable, and the note says so.
 */

import type { Budget } from "./budget-for";

const CHANGE_IT = "Change it under Settings → Limits, or on the column; the run can be retried.";

export function tokenLimitNote(budget: Budget, used: number): string {
  const limit = budget.tokens.value ?? 0;
  return `Token limit reached (${used.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")} tokens, input plus output). Enforced between turns: the run stops before its next turn. ${CHANGE_IT}`;
}

export function timeLimitNote(budget: Budget): string {
  const { value, clamp } = budget.minutes;
  if (clamp) {
    return `Time limit reached (${value} minutes). That is the ${clamp.rail} hard rail, held below what the ticket asked for (${budget.minutes.requested ?? "no limit"} minutes): the run stops itself between turns before the platform would end it. Run it where the rail is wider, such as an agent on a job. ${CHANGE_IT}`;
  }
  return `Time limit reached (${value} minutes). Enforced between turns: the run stops before its next turn. ${CHANGE_IT}`;
}

export function attemptsLimitNote(budget: Budget): string {
  return `Attempt limit reached (${budget.attempts.value} attempts). Enforced between turns. ${CHANGE_IT}`;
}

export function epicLimitNote(axis: "time" | "attempts", limit: number): string {
  return axis === "time"
    ? `Epic time limit reached (${Math.round(limit / 60_000)} minutes of run time across its runs). Its runs are stopped and can be retried.`
    : `Epic attempt limit reached (${limit} failed or stopped runs). Its runs are stopped and can be retried.`;
}
