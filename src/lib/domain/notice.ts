import { isStalled, type ColumnId, type TicketStatus } from "./status";

/**
 * A stalled card told apart by what it asks of a person: a critical stop is a
 * warning, a pause that waits for the person to act (authorize more files,
 * add a key) is an alert. A dependency wait is neither, so it has no notice.
 */
export type Notice = {
  severity: "warning" | "alert";
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
}): Notice | null {
  if (!isStalled(card.status)) return null;
  const longDescription = card.blockedReason ?? "";
  const shortDescription = longDescription.split("\n", 1)[0]?.trim() ?? "";

  if (card.status === "failed") {
    return { severity: "warning", title: "Failed", shortDescription, longDescription };
  }
  const title = SCOPE_REQUEST_REASON.test(longDescription) ? "Needs authorization" : "Waiting for you";
  return { severity: "alert", title, shortDescription, longDescription };
}
