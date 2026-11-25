import { linkify } from "@/components/ui/links";

/**
 * Prose where every URL is a link and the words around it stay words.
 *
 * A blocked reason is one sentence written for a person, and some of them name
 * the pull request that person has to merge. A sentence they can click through
 * beats one that makes them copy an address out of parentheses. Text with no
 * URL in it renders exactly as it did before.
 */
export function LinkifiedText({ text }: { text: string }) {
  return <>{linkify(text)}</>;
}
