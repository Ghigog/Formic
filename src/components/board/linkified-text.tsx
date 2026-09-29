import type { ReactNode } from "react";

/**
 * A URL in prose. It stops at whitespace, a closing bracket or a quote, so a
 * sentence's own punctuation — "…once (https://…/pull/7), then try again." —
 * stays out of the address instead of breaking it.
 */
const URL_IN_PROSE = /https?:\/\/[^\s<>"')\]]+/g;

/** A full stop or comma trailing a URL: the sentence's, not the URL's. */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/**
 * Prose where every URL is a link and the words around it stay words.
 *
 * A blocked reason is one sentence written for a person, and some of them name
 * the pull request that person has to merge. A sentence they can click through
 * beats one that makes them copy an address out of parentheses. Text with no
 * URL in it renders exactly as it did before.
 */
export function LinkifiedText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let at = 0;

  for (const match of text.matchAll(URL_IN_PROSE)) {
    const url = match[0]!.replace(TRAILING_PUNCTUATION, "");
    if (match.index > at) parts.push(text.slice(at, match.index));
    parts.push(
      <a
        key={match.index}
        href={url}
        target="_blank"
        rel="noreferrer"
        className="text-ink underline"
      >
        {url}
      </a>,
    );
    at = match.index + url.length;
  }

  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}
