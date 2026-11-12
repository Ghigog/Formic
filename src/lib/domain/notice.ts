import { isQuestion } from "./question";
import { isStalled, type ColumnId, type TicketStatus } from "./status";

/**
 * A stalled card told apart by what it asks of a person: a critical stop is a
 * warning, a pause that waits for the person to act (authorize more files,
 * add a key) is an alert, and an agent waiting on the person's answer is a
 * question (see ./question.ts). A dependency wait is none of them, so it has
 * no notice.
 */
export type Notice = {
  severity: "warning" | "alert" | "question";
  title: string;
  shortDescription: string;
  longDescription: string;
};

/** The reason askForScope (coder/scope-request.ts) gives a ticket that needs more files. */
const SCOPE_REQUEST_REASON = /^Needs files outside its scope:/;

/** The first line of a blocked card's reason when its run went 30 minutes without a new commit; the lines after it say what each run last did. */
export const STUCK_RUN = "Run stuck: no new commits for 30 minutes";

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

  if (isQuestion(card.blockedReason)) {
    return { severity: "question", title: "Question for you", shortDescription: shortDescription.replace(/^Question: /, ""), longDescription };
  }
  if (card.status === "failed") {
    return { severity: "warning", title: "Failed", shortDescription, longDescription };
  }
  if (shortDescription === STUCK_RUN) return { severity: "alert", title: "Stuck", shortDescription, longDescription };
  const title = SCOPE_REQUEST_REASON.test(shortDescription) ? "Needs authorization" : "Waiting for you";
  return { severity: "alert", title, shortDescription, longDescription };
}

/** The failure type runner.ts gives a card whose agent ran out of usage mid-run. */
export const USAGE_LIMIT = "Usage limit reached";

/** The wording limitReason (agents/presets.ts) puts between the agent's name and the reset time. */
export const OUT_OF_USAGE_PHRASE = " is out of usage until ";

/**
 * Whether a stalled card waits for an agent's usage to come back: its run hit
 * the limit, or the start gate refused it because the column's agent was
 * already out of usage.
 */
export function isUsageLimitStop(card: Parameters<typeof classifyNotice>[0]): boolean {
  const short = classifyNotice(card)?.shortDescription;
  return short === USAGE_LIMIT || (!!short && short.includes(OUT_OF_USAGE_PHRASE) && short.endsWith("."));
}
