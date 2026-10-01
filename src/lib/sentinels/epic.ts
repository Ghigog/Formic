import type { AuditPoint, AuditReport } from "@/lib/db/repository";
import type { Sentinel } from "./roster";

/** createBacklogItem refuses a request longer than this (see POST /api/epics). */
export const REQUEST_CAP = 4000;

const SECTIONS = [
  { key: "dislikes", title: "What doesn't work" },
  { key: "wrong", title: "What's wrong" },
  { key: "missing", title: "What's missing" },
] as const;

const line = (p: AuditPoint) => `- ${p.text}${p.ref ? ` (${p.ref})` : ""}`;

/**
 * The request a Product Agent writes an Epic's PRD from: the sentinel's
 * report minus what works. A list too long for the cap loses its last points.
 */
export function requestFromReport(
  sentinel: Pick<Sentinel, "who" | "name">,
  audit: { stars: number; summary: string | null; report: AuditReport },
): string {
  const head = [
    `Fix what ${sentinel.who} (${sentinel.name}) found in their audit. They rated the project ${audit.stars} of 5 stars.`,
    audit.summary ? `Summary: ${audit.summary}` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 1000);

  const blocks = SECTIONS.map((s) => ({ title: s.title, lines: audit.report[s.key].map(line) })).filter(
    (b) => b.lines.length > 0,
  );
  const render = () => [head, ...blocks.map((b) => `${b.title}:\n${b.lines.join("\n")}`)].join("\n\n");

  let text = render();
  while (text.length > REQUEST_CAP) {
    const longest = blocks.reduce((a, b) => (b.lines.length > a.lines.length ? b : a));
    if (longest.lines.length === 0) return text.slice(0, REQUEST_CAP);
    longest.lines.pop();
    text = render();
  }
  return text;
}
