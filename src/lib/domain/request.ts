/**
 * The longest request a person may write for a ticket or an Epic, in
 * characters. The database stores any length; this cap only stops a whole
 * document being pasted in, which every agent would re-read on each run.
 */
export const MAX_REQUEST = 16_000;
