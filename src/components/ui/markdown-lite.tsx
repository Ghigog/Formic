import { Fragment, type ReactNode } from "react";
import { cn } from "./cn";

/**
 * The little Markdown tickets are written in: headings, bullet and numbered
 * lists, paragraphs, **bold**, __bold__, *italic*, _italic_, `code` and fenced code blocks. Rendered as elements, never as HTML, so
 * text an agent wrote cannot inject markup.
 */
export function MarkdownLite({
  text,
  className,
  keepLineBreaks = false,
}: {
  text: string;
  className?: string;
  /** Keep a single line break inside a paragraph, as chat text relies on. */
  keepLineBreaks?: boolean;
}) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let ordered = false;
  let paragraph: string[] = [];

  const flushList = () => {
    if (list.length === 0) return;
    const items = list.map((item, i) => <li key={i}>{inline(item)}</li>);
    blocks.push(
      ordered ? (
        <ol key={blocks.length} className="ml-5 list-decimal space-y-1">
          {items}
        </ol>
      ) : (
        <ul key={blocks.length} className="ml-4 list-disc space-y-1">
          {items}
        </ul>
      ),
    );
    list = [];
  };
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(
      <p key={blocks.length}>
        {keepLineBreaks
          ? paragraph.map((l, i) => (
              <Fragment key={i}>
                {i > 0 && <br />}
                {inline(l)}
              </Fragment>
            ))
          : inline(paragraph.join(" "))}
      </p>,
    );
    paragraph = [];
  };

  let fence: string[] | null = null;
  const flushFence = () => {
    if (fence === null) return;
    blocks.push(
      <pre
        key={blocks.length}
        className="bg-sunken overflow-x-auto rounded p-2 font-mono text-[0.9em] leading-5"
      >
        <code>{fence.join("\n")}</code>
      </pre>,
    );
    fence = null;
  };

  for (const raw of text.split(/\r?\n/)) {
    if (fence !== null) {
      if (raw.trim().startsWith("```")) flushFence();
      else fence.push(raw);
      continue;
    }
    if (raw.trim().startsWith("```")) {
      flushList();
      flushParagraph();
      fence = [];
      continue;
    }
    const line = raw.trimEnd();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flushList();
      flushParagraph();
      blocks.push(
        <h4
          key={blocks.length}
          className="text-fg-subtle pt-2 font-mono text-[10px] tracking-wide uppercase"
        >
          {heading[1]}
        </h4>,
      );
    } else if (bullet || numbered) {
      flushParagraph();
      if (list.length && ordered !== !!numbered) flushList();
      ordered = !!numbered;
      list.push((bullet ?? numbered)![1]!);
    } else if (line.trim() === "") {
      flushList();
      flushParagraph();
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushFence();
  flushList();
  flushParagraph();

  return <div className={cn("space-y-2", className)}>{blocks}</div>;
}

// Marks must hug their text. Underscores and single stars never start or end
// inside a word (snake_case) and a star never pairs with a bullet's or a **.
const INLINE =
  /(`[^`]+`|\*\*(?=\S)[^*]+?(?<=\S)\*\*|(?<!\w)__(?=\S).+?(?<=\S)__(?!\w)|(?<![\w*])\*(?=[^\s*])[^*]+?(?<=[^\s*])\*(?![\w*])|(?<!\w)_(?=[^\s_])[^_]+?(?<=[^\s_])_(?!\w))/g;

/** Bold, italic and `code` inside a line. */
function inline(text: string): ReactNode {
  return text.split(INLINE).map((part, i) => {
    if (i % 2 === 0) return <Fragment key={i}>{part}</Fragment>;
    if (part.startsWith("`")) {
      return (
        <code key={i} className="bg-sunken rounded px-1 font-mono text-[0.9em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") || part.startsWith("__")) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return <em key={i}>{part.slice(1, -1)}</em>;
  });
}
