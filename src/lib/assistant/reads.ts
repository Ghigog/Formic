import "server-only";

/**
 * Reading a file that is longer than one tool result.
 *
 * The assistant's `read_file` sends a file through `truncate`, which keeps the
 * first and last 8,000 characters of a 16,000 character budget and drops the
 * middle. That is fine for a model skimming a file; it is useless for a model
 * asked to act on what the middle says. A 34,000 character plan comes back
 * with its ticket list gone, and no amount of reading it again brings it back:
 * the model has no way to ask for a range, so it reads the same head and tail
 * until its turns run out.
 *
 * So a read of a long file is a window that says where it is: the model can
 * walk the whole file a window at a time, or go straight to an offset.
 */

/** How much of a file one read returns. Matches MAX_TOOL_OUTPUT. */
export const READ_WINDOW = 16_000;

/**
 * One window of `text`, starting at `offset`, with a line saying where it sits
 * and how to carry on. A file that fits in one window comes back untouched.
 */
export function readWindow(path: string, text: string, offset = 0): string {
  const total = text.length;
  const from = Math.max(0, Math.min(offset, total));

  if (from === 0 && total <= READ_WINDOW) return text;

  const body = text.slice(from, from + READ_WINDOW);
  const to = from + body.length;

  if (body.length === 0) {
    return `[${path} is ${total} characters; offset ${offset} is past the end. Read from 0.]`;
  }

  const where = `[${path}: characters ${from}-${to} of ${total}]`;
  const more = to < total ? `\n[More: call read_file with offset=${to}.]` : "";
  return `${where}\n${body}${more}`;
}

/**
 * What the person is told when the turns run out. The old wording ("I read a
 * lot and did not reach an answer") hid everything worth knowing: which files
 * it read, how many rounds it spent, and whether a tool was failing.
 */
export function outOfRoundsMessage(
  files: string[],
  rounds: number,
  lastError: string | null,
): string {
  const read = files.length === 1 ? "1 file" : `${files.length} files`;
  const said = lastError ? ` The last thing a tool told me was: "${lastError}"` : "";
  return `I read ${read} over ${rounds} rounds and did not reach an answer.${said} Try a narrower question, or name the file and section you mean.`;
}
