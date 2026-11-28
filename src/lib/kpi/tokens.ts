/**
 * Tokens by column stay. A card's work (agent runs and chat answers) is split
 * by the stay it began in, so the card face, its drawer and the KPI screen
 * all count tokens the same way. Pure: no framework or database.
 */

/** One stay in a column, as the repositories record it. */
export interface TokenStay {
  column: string;
  enteredAt: string;
  exitedAt: string | null;
}

/** One piece of work: a run or a chat answer. `at` is when it began (ISO). */
export interface TokenWork {
  at: string;
  tokensIn: number;
  tokensOut: number;
  /** False when the work finished and reported no tokens at all. */
  reported: boolean;
}

export interface StayTokens {
  column: string;
  enteredAt: string;
  exitedAt: string | null;
  tokensIn: number;
  tokensOut: number;
  /** Some work in this stay finished without reporting its tokens. */
  unreported: boolean;
}

/** What one stay used; the card's `columnTokens` is its open stay's. */
export interface ColumnTokens {
  tokensIn: number;
  tokensOut: number;
  unreported: boolean;
}

/**
 * One row per stay, in the order given. An item counts toward the stay whose
 * [enteredAt, exitedAt) holds its `at`, so a run spanning a move stays with
 * the column it began in; one before the first stay goes to the first.
 */
export function tokensByStay(entries: readonly TokenStay[], work: readonly TokenWork[]): StayTokens[] {
  const rows: StayTokens[] = entries.map((e) => ({
    column: e.column,
    enteredAt: e.enteredAt,
    exitedAt: e.exitedAt,
    tokensIn: 0,
    tokensOut: 0,
    unreported: false,
  }));
  if (rows.length === 0) return rows;
  const starts = entries.map((e) => new Date(e.enteredAt).getTime());
  for (const item of work) {
    const at = new Date(item.at).getTime();
    let index = 0;
    for (let i = 0; i < starts.length; i++) if (starts[i]! <= at) index = i;
    const row = rows[index]!;
    row.tokensIn += item.tokensIn;
    row.tokensOut += item.tokensOut;
    if (!item.reported) row.unreported = true;
  }
  return rows;
}

/** The open (last) stay's tokens, or null when the card has no stay. */
export function openStayTokens(entries: readonly TokenStay[], work: readonly TokenWork[]): ColumnTokens | null {
  const last = tokensByStay(entries, work).at(-1);
  return last ? { tokensIn: last.tokensIn, tokensOut: last.tokensOut, unreported: last.unreported } : null;
}
