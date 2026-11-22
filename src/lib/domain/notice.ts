import { isQuestion } from "./question";
import { isStalled, type ColumnId, type TicketStatus } from "./status";

/**
 * A stalled card told apart by what it asks of a person: a critical stop is a
 * warning, a pause that waits for the person to act (authorize more files,
 * add a key) is an alert, and an agent waiting on the person's answer is a
 * question (see ./question.ts). A card waiting for an agent's usage to come
 * back is paused: nothing is wrong and nothing is asked. A dependency wait is none of them, so it has
 * no notice.
 */
export type Notice = {
  severity: "warning" | "alert" | "question" | "paused";
  title: string;
  shortDescription: string;
  longDescription: string;
};

/** The reason askForScope (coder/scope-request.ts) gives a ticket that needs more files. */
const SCOPE_REQUEST_REASON = /^Needs files outside its scope:/;

/** The first line of a blocked card's reason when its run went 30 minutes without a new commit; the lines after it say what each run last did. */
export const STUCK_RUN = "Run stuck: no new commits for 30 minutes";

/** What a blocked card's reason starts with when the review ceiling stopped it (ceilingReason in review/pipeline.ts); the lines after it say what failed and what the person can do. */
export const REVIEW_CEILING = "Out of reviews";

const WAITING_ON = /^Waiting on (?:#(\d+)|([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)), then updates from main$/;

/** The reason for a blocked card that waits on a fix to land on main, then updates its branch; target is a pull request ("#726") or a ticket key ("EPIC-122-T3"). */
export function waitingOnReason(target: string): string {
  return `Waiting on ${target}, then updates from main`;
}

/** What a blocked reason's first line waits on, or null when it is not a waitingOnReason. */
export function waitedOn(reason: string | null | undefined): { pull: number | null; key: string | null } | null {
  const m = WAITING_ON.exec((reason ?? "").split("\n", 1)[0]!.trim());
  if (!m) return null;
  return { pull: m[1] ? Number(m[1]) : null, key: m[2] ?? null };
}

export function classifyNotice(card: {
  status: TicketStatus;
  stalledIn?: ColumnId | null;
  blockedReason?: string | null;
  workingSince?: string | null;
}): Notice | null {
  // An agent is on it (e.g. drafting the ticket), so nothing is asked of a person; same rule as cardProblem.
  if (card.workingSince) return null;
  if (!isStalled(card.status)) return null;
  // First line is the error type; the rest is the detail (see whyItFailed in runner/runner.ts).
  const [first = "", ...rest] = (card.blockedReason ?? "").split("\n");
  const shortDescription = first.trim();
  const longDescription = rest.join("\n").trim();

  if (card.status === "blocked" && waitedOn(shortDescription)) {
    return { severity: "alert", title: shortDescription, shortDescription: "", longDescription };
  }
  if (isQuestion(card.blockedReason)) {
    return { severity: "question", title: "Question for you", shortDescription: shortDescription.replace(/^Question: /, ""), longDescription };
  }
  if (isUsageLimitReason(shortDescription)) {
    return { severity: "paused", title: "Paused for usage limit", shortDescription, longDescription };
  }
  if (card.status === "failed" && shortDescription === NO_CHANGES) {
    const [subtitle = "", ...description] = rest;
    return {
      severity: "warning",
      title: NO_CHANGES,
      shortDescription: subtitle.trim(),
      longDescription: description.join("\n").trim(),
    };
  }
  if (card.status === "failed") {
    return { severity: "warning", title: "Failed", shortDescription, longDescription };
  }
  if (shortDescription === STUCK_RUN) return { severity: "alert", title: "Stuck", shortDescription, longDescription };
  if (shortDescription.startsWith(REVIEW_CEILING)) return { severity: "alert", title: REVIEW_CEILING, shortDescription, longDescription };
  const title = SCOPE_REQUEST_REASON.test(shortDescription) ? "Needs authorization" : "Waiting for you";
  return { severity: "alert", title, shortDescription, longDescription };
}

/** The title runner.ts gives a card whose agent ended without changing a file. */
export const NO_CHANGES = "No changes made";

/** The failure type runner.ts gives a card whose agent ran out of usage mid-run. */
export const USAGE_LIMIT = "Usage limit reached";

/** The wording limitReason (agents/presets.ts) puts between the agent's name and the reset time. */
export const OUT_OF_USAGE_PHRASE = " is out of usage until ";

function isUsageLimitReason(short: string): boolean {
  return short === USAGE_LIMIT || (short.includes(OUT_OF_USAGE_PHRASE) && short.endsWith("."));
}

/**
 * Whether a stalled card waits for an agent's usage to come back: its run hit
 * the limit, or the start gate refused it because the column's agent was
 * already out of usage.
 */
export function isUsageLimitStop(card: Parameters<typeof classifyNotice>[0]): boolean {
  return classifyNotice(card)?.severity === "paused";
}
