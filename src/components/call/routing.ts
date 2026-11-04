/**
 * Who a spoken turn is for, on the client. The addressing rules are the ones
 * the server answers by (src/lib/calls/routing.ts, pure and shared); the
 * greeting check is the call bar's own.
 */
export { detectAddGuest, resolveAddressee } from "@/lib/calls/routing";

const EVERYONE = /\b(?:hello|hey|hi|hiya|good\s+(?:morning|afternoon|evening))[\s,]+(?:everyone|everybody|all|team|folks|guys)\b/i;

/** Whether the person greets the whole call ("hello everyone"). */
export function isHelloEveryone(text: string): boolean {
  return EVERYONE.test(text);
}

/** Said after a greeting to everyone, so each guest answers in one line. */
export const HELLO_ASK = "Each of you, answer with a one-line hello.";
