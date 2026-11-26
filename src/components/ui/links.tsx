import type { ReactNode } from "react";

/**
 * A URL in prose. It stops at whitespace, a closing bracket or a quote, so a
 * sentence's own punctuation — "…once (https://…/pull/7), then try again." —
 * stays out of the address instead of breaking it.
 */
const URL_IN_PROSE = /https?:\/\/[^\s<>"')\]]+/g;

/** A full stop or comma trailing a URL: the sentence's, not the URL's. */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/** Whether an address may become a link: http and https only, never another scheme. */
export function isWebUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url);
}

/** A link that opens in a new tab, in the product's one link style. */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-ink hover:text-terracotta [overflow-wrap:anywhere] underline underline-offset-2"
    >
      {children}
    </a>
  );
}

/** Text with every http(s) URL turned into a link and the words around it left as words. */
export function linkify(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let at = 0;

  for (const match of text.matchAll(URL_IN_PROSE)) {
    const url = match[0]!.replace(TRAILING_PUNCTUATION, "");
    if (match.index > at) parts.push(text.slice(at, match.index));
    parts.push(
      <ExternalLink key={match.index} href={url}>
        {url}
      </ExternalLink>,
    );
    at = match.index + url.length;
  }

  if (at < text.length) parts.push(text.slice(at));
  return parts;
}
