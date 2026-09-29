import type { ReactNode } from "react";

/**
 * Splits plain text on URLs and renders each URL as a link that opens in a
 * new tab, leaving the surrounding text untouched. Used where a blocked
 * reason names the runner's setup pull request, so the owner can merge it
 * without copying the URL by hand.
 */
const URL_PATTERN = /(https?:\/\/[^\s)]+)/g;

export function LinkifiedText({ text }: { text: string }): ReactNode {
  // With a capture group, split interleaves the plain text with the URLs.
  return text.split(URL_PATTERN).map((part, i) =>
    i % 2 === 1 ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noreferrer"
        className="text-ink underline"
      >
        {part}
      </a>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}
