import "server-only";

import type { FollowUp } from "@/lib/agents/follow-ups";
import type { TokenScope } from "@/lib/access-tokens";
import { withActor } from "@/lib/auth/actor";
import { credentialsForProject } from "@/lib/auth/credentials";
import { canSeeBoard } from "@/lib/board/sharing";
import { repository } from "@/lib/db";
import type { ProjectSummary, UserRecord } from "@/lib/db/repository";
import { COLUMN_LABELS, type ColumnId } from "@/lib/domain/status";
import { vcs } from "@/lib/vcs";
import {
  addDependency,
  answerCardQuestion,
  checkAction,
  openPmPullRequest,
  rerunCi,
  updateBranchFromBase,
  type AssistantAction,
} from "@/lib/assistant/actions";
import { cardReport } from "@/lib/assistant/context";
import { postPmMessage } from "@/lib/assistant/pm-messages";
import type { ToolResult } from "./tools";

/**
 * The tools only a PM token has (PM chat plan, PR 2). Each one is held to
 * the token's board, and the approval rules live here, on the server, not
 * in the PM's prompt: closing, archiving, deleting or merging, and adding a
 * card nobody asked for, never happen from a PM's call. They become a
 * proposal in the board chat for the person to approve, whatever the model
 * was told by a PR comment, a log or a file it read.
 */

/** Who is calling: the person the PM acts for, and the one board its token is for. */
export interface PmCaller {
  user: UserRecord;
  scope: TokenScope;
}

export const WRONG_BOARD = "This token works only on its own board.";

/** What a gated tool answers: nothing changed, the person decides. */
export interface Proposed {
  proposed: true;
  messageId: string;
  note: string;
}

const PROPOSED_NOTE = "Nothing has changed yet. The person approves or dismisses this in the board chat.";

/** Runs a PM tool on its own board only, as the person, or says why not. */
export async function onPmBoard<T>(
  caller: PmCaller,
  boardId: string,
  run: (project: ProjectSummary) => Promise<ToolResult<T>>,
): Promise<ToolResult<T>> {
  if (boardId !== caller.scope.projectId) return { ok: false, error: WRONG_BOARD };
  const project = await repository().projectById(boardId);
  if (!project || !(await canSeeBoard(caller.user, project))) return { ok: false, error: "Board not found" };
  return withActor(caller.user.id, async () => {
    try {
      return await run(project);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

/** A card, from its id or its key in any case. */
async function cardOf(projectId: string, ref: string): Promise<{ id: string; key: string } | null> {
  const wanted = ref.trim().toLowerCase();
  return (await repository().boardCards(projectId)).find((c) => c.id === ref || c.key.toLowerCase() === wanted) ?? null;
}

/** A card's key, from its id or its key in any case. */
async function keyOf(projectId: string, ref: string): Promise<string> {
  const card = await cardOf(projectId, ref);
  if (!card) throw new Error(`${ref} is not on the board.`);
  return card.key;
}

/** Puts a change to the person instead of making it. */
export async function propose(projectId: string, summary: string, action: AssistantAction): Promise<ToolResult<Proposed>> {
  const checked = checkAction(action);
  if (!checked.ok) return { ok: false, error: checked.problem };
  const message = await postPmMessage(projectId, {
    content: summary,
    proposals: [{ summary, action: checked.action, state: "proposed" }],
  });
  return { ok: true, value: { proposed: true, messageId: message.id, note: PROPOSED_NOTE } };
}

const done = (text: string): ToolResult<{ done: string }> => ({ ok: true, value: { done: text } });

/* What a wake-up may start. */

/** What a wake-up hears once it has already started agent work. */
export const ONE_START = "This turn was a wake-up and it has already started agent work once, which spends the person's Claude usage. Do not start more: tell the person in one line what you would do next and let them decide.";

/**
 * Whether this turn may start agent work (move a card into a working column,
 * restart an agent with an answer, add an Epic ready to run). A turn the
 * person started may, always. A wake-up may once: every start spends the
 * person's Claude usage, and a wake-up is the PM acting unasked. The start
 * is counted when it is allowed.
 */
export async function mayStartWork(caller: PmCaller, projectId: string, cardId: string): Promise<boolean> {
  const { scope } = caller;
  if (!scope.wake || !scope.tokenId) return true;
  const repo = repository();
  const since = new Date(Date.now() - 24 * 3_600_000);
  const started = (await repo.pmWakes(projectId, { since })).some((r) => r.kind === "started" && r.head === scope.tokenId);
  if (started) return false;
  await repo.addPmWake({ projectId, cardId, head: scope.tokenId, kind: "started", createdAt: new Date() });
  return true;
}

/** A move that starts an agent: to a column past the Backlog, short of Done (which is a proposal already). */
export const startsWork = (to: string) => to !== "backlog" && to !== "done";

/** A wake-up's second start of a move becomes a proposal; null when the move may go ahead. */
export async function gateMove(caller: PmCaller, input: { board: string; card: string; to: ColumnId }): Promise<ToolResult<Proposed> | null> {
  if (!startsWork(input.to)) return null;
  if (input.board !== caller.scope.projectId) return { ok: false, error: WRONG_BOARD };
  const card = await cardOf(input.board, input.card);
  if (!card) return { ok: false, error: `${input.card} is not on the board.` };
  if (await mayStartWork(caller, input.board, card.id)) return null;
  return withActor(caller.user.id, () =>
    propose(input.board, `Move ${card.key} to ${COLUMN_LABELS[input.to]}?`, { type: "move_card", key: card.key, to: input.to }),
  );
}

/* Reads and direct actions. */

export function cardStatus(caller: PmCaller, input: { board: string; card: string }) {
  return onPmBoard(caller, input.board, async (project) => {
    const key = await keyOf(project.id, input.card);
    const creds = await credentialsForProject(project);
    return { ok: true as const, value: await cardReport(project.id, key, vcs(project.repoFullName ?? "", creds.repoToken)) };
  });
}

export function rerunChecks(caller: PmCaller, input: { board: string; card: string }) {
  return onPmBoard(caller, input.board, async (project) => done(await rerunCi(project.id, await keyOf(project.id, input.card))));
}

export function updateBranch(caller: PmCaller, input: { board: string; card: string }) {
  return onPmBoard(caller, input.board, async (project) =>
    done(await updateBranchFromBase(project.id, await keyOf(project.id, input.card))),
  );
}

export function openPullRequest(
  caller: PmCaller,
  input: { board: string; branch: string; title: string; body: string; unblocks?: string },
) {
  return onPmBoard(caller, input.board, async (project) => done(await openPmPullRequest(project.id, input)));
}

export function answerQuestion(caller: PmCaller, input: { board: string; card: string; answer: string; own: boolean }) {
  return onPmBoard(caller, input.board, async (project) => {
    const card = await cardOf(project.id, input.card);
    if (!card) throw new Error(`${input.card} is not on the board.`);
    const key = card.key;
    // An answer starts the card's agent again.
    if (!(await mayStartWork(caller, project.id, card.id))) return { ok: false as const, error: ONE_START };
    return done(await answerCardQuestion(project.id, key, input.answer, input.own));
  });
}

export function addCardDependency(caller: PmCaller, input: { board: string; card: string; dependsOn: string }) {
  return onPmBoard(caller, input.board, async (project) =>
    done(await addDependency(project.id, await keyOf(project.id, input.card), await keyOf(project.id, input.dependsOn))),
  );
}

/* Gated: always a proposal. */

export function closeCard(caller: PmCaller, input: { board: string; card: string; reason: string }) {
  return onPmBoard(caller, input.board, async (project) => {
    const key = await keyOf(project.id, input.card);
    return propose(project.id, `Close ${key}? ${input.reason}`, { type: "close_card", key, reason: input.reason });
  });
}

export function mergePullRequest(caller: PmCaller, input: { board: string; card: string }) {
  return onPmBoard(caller, input.board, async (project) => {
    const key = await keyOf(project.id, input.card);
    return propose(project.id, `Merge ${key}'s pull request?`, { type: "merge_pull_request", key });
  });
}

/** A move to Done is a merge (or an Epic's close), so it is put to the person. */
export function proposeDone(caller: PmCaller, input: { board: string; card: string }) {
  return onPmBoard(caller, input.board, async (project) => {
    const key = await keyOf(project.id, input.card);
    return propose(project.id, `Move ${key} to ${COLUMN_LABELS.done}? For a ticket that merges its pull request.`, {
      type: "move_card",
      key,
      to: "done",
    });
  });
}

/** A card the person did not ask for: a nice-to-have the PM thought of. */
export function proposeCard(caller: PmCaller, input: { board: string; request: string; column: "backlog" | "todo"; why: string }) {
  return onPmBoard(caller, input.board, async (project) => {
    const action: AssistantAction =
      input.column === "todo"
        ? { type: "create_todo_item", request: input.request }
        : { type: "create_backlog_item", request: input.request };
    return propose(project.id, `Add to ${COLUMN_LABELS[input.column]}: ${input.request} (${input.why})`, action);
  });
}

export function addFollowUp(caller: PmCaller, input: { board: string; ticket: string; title: string }) {
  return onPmBoard(caller, input.board, async (project) => {
    const key = await keyOf(project.id, input.ticket);
    return propose(project.id, `Add ${key}'s follow-up "${input.title}"?`, { type: "add_follow_up", ticket: key, title: input.title });
  });
}

/* Follow-ups nobody asked for, however a create call words them. */

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * A nice-to-have follow-up an agent left on one of the board's tickets that
 * a new card's text repeats, if any. Creating that card is creating the
 * follow-up, so it goes to the person like add_follow_up does.
 */
export async function optionalFollowUpIn(
  projectId: string,
  texts: string[],
): Promise<{ ticket: string; followUp: FollowUp } | null> {
  const repo = repository();
  const said = texts.map(squash).filter(Boolean);
  if (!said.length) return null;
  const tickets = (await repo.boardCards(projectId)).filter((c) => c.kind === "ticket" && !c.archived);
  for (const card of tickets) {
    const detail = await repo.ticketDetail(card.id);
    for (const f of detail?.followUps ?? []) {
      const open = !f.outcome || f.outcome.kind === "pending" || f.outcome.kind === "proposed";
      const title = squash(f.title);
      if (f.need === "nice" && open && title && said.some((s) => s === title || s.includes(title))) {
        return { ticket: card.key, followUp: f };
      }
    }
  }
  return null;
}

/**
 * Before a PM creates cards: when they repeat an optional follow-up, the
 * answer is a proposal and nothing is created. Null when creating may go on.
 */
export async function gateOptional(caller: PmCaller, boardId: string, texts: string[]): Promise<ToolResult<Proposed> | null> {
  if (boardId !== caller.scope.projectId) return { ok: false, error: WRONG_BOARD };
  const hit = await optionalFollowUpIn(boardId, texts);
  if (!hit) return null;
  return withActor(caller.user.id, () =>
    propose(boardId, `Add ${hit.ticket}'s optional follow-up "${hit.followUp.title}"?`, {
      type: "add_follow_up",
      ticket: hit.ticket,
      title: hit.followUp.title,
    }),
  );
}
