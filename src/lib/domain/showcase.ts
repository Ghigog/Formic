import { HANDOFF_INTRO } from "@/lib/agents/handoff";

/**
 * The showcase's opening sentence: what is now possible. The rest of it is
 * how to see that, which is for the showcase itself, not a summary of it.
 * Headings, lists and the "For you" section (its heading and the line that
 * introduces its steps) are passed over, so an older showcase that opened
 * with a heading still gives its first plain paragraph.
 */
export function showcaseHeadline(markdown: string): string | null {
  let forYou = false;
  for (const p of markdown.split(/\n\s*\n/)) {
    const text = p.trim();
    if (!text) continue;
    if (/^#+\s*for you\b/i.test(text)) {
      forYou = true;
      continue;
    }
    if (/^(#|[-*]\s|\d+[.)]\s)/.test(text)) continue;
    if (forYou) {
      forYou = false;
      if (text === HANDOFF_INTRO) continue;
    }
    return text.replace(/\s*\n\s*/g, " ").replace(/\*\*|__/g, "");
  }
  return null;
}
