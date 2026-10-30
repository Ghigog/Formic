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
  const title = SCOPE_REQUEST_REASON.test(shortDescription) ? "Needs authorization" : "Waiting for you";
  return { severity: "alert", title, shortDescription, longDescription };
}
