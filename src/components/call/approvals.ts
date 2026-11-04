export type SpokenDecision = "approve" | "dismiss" | "none";

export const MERGE_HINT = "Say 'yes, merge it' to merge.";

/** What a spoken yes or no is about: the proposal's action. */
type Proposal = { action: unknown };

const YES = /^(yes|yeah|yep|yup|sure|ok|okay|approve|approved|do it|go ahead|go for it|please do|yes please|yes do it|yes go ahead|sounds good)$/;
const NO = /^(no|nope|nah|dismiss|don'?t|do not|no thanks|no thank you|cancel|never mind|skip it)$/;
const MERGE = /^(yes,? )?merge it$/;

function words(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether a proposal moves a ticket to Done, which merges it. */
export function movesToDone(proposal: Proposal): boolean {
  const a = proposal.action as { type?: string; to?: string } | null;
  return a?.type === "move_card" && a.to === "done";
}

/**
 * What the person's words decide about a proposal read aloud. A move to Done
 * merges, so a plain yes is not enough: only "yes, merge it" approves it.
 */
export function spokenDecision(text: string, proposal: Proposal): SpokenDecision {
  const said = words(text);
  if (NO.test(said.replace(/,/g, ""))) return "dismiss";
  if (movesToDone(proposal)) return MERGE.test(said) ? "approve" : "none";
  return YES.test(said.replace(/,/g, "")) ? "approve" : "none";
}

/** What the PM says when a plain yes is not enough, or null when it is. */
export function mergeHint(text: string, proposal: Proposal): string | null {
  if (!movesToDone(proposal)) return null;
  return YES.test(words(text).replace(/,/g, "")) ? MERGE_HINT : null;
}
