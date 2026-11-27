/** The one name for how many changes a ticket took after it was specified. */
export const CHANGES_AFTER_SPEC_LABEL = "Changes after spec";

export function changesText(n: number): string {
  return n === 0 ? "No changes" : n === 1 ? "1 change" : `${n} changes`;
}
