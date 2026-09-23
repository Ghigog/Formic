import { Fragment, type ReactNode } from "react";
import { cn } from "./cn";

/**
 * The little Markdown tickets are written in: headings, bullet lists,
 * paragraphs, **bold** and `code`. Rendered as elements, never as HTML, so
 * text an agent wrote cannot inject markup.
 */
export function MarkdownLite({ text, className }: { text: string; className?: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let paragraph: string[] = [];

  const flushList = () => {
    if (list.length === 0) return;
    blocks.push(
      <ul key={blocks.length} className="ml-4 list-disc space-y-1">
        {list.map((item, i) => (
          <li key={i}>{inline(item)}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(<p key={blocks.length}>{inline(paragraph.join(" "))}</p>);
    paragraph = [];
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
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
    } else if (bullet) {
      flushParagraph();
      list.push(bullet[1]!);
    } else if (line.trim() === "") {
      flushList();
      flushParagraph();
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushList();
  flushParagraph();

  return <div className={cn("space-y-2", className)}>{blocks}</div>;
}

/** **bold** and `code` inside a line. */
function inline(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code key={i} className="bg-sunken rounded px-1 font-mono text-[0.9em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}
