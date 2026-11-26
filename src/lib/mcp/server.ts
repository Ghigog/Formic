import "server-only";

import { workedOn } from "@/lib/agents/limit-lift";
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TokenScope } from "@/lib/access-tokens";
import type { UserRecord } from "@/lib/db/repository";
import { repository } from "@/lib/db";
import { prdSchema } from "@/lib/domain/entities";
import { MAX_REQUEST } from "@/lib/domain/request";
import { COLUMNS } from "@/lib/domain/status";
import {
  commentCard,
  createBacklogCard,
  createEpic,
  getCard,
  getColony,
  listBoards,
  listCards,
  moveCard,
  updateCard,
  type ToolResult,
} from "./tools";
import {
  addCardDependency,
  addFollowUp,
  answerQuestion,
  cardStatus,
  closeCard,
  gateOptional,
  mergePullRequest,
  openPullRequest,
  proposeCard,
  proposeDone,
  rerunChecks,
  updateBranch,
  WRONG_BOARD,
  type PmCaller,
  gateMove,
  mayStartWork,
  ONE_START,
} from "./pm-tools";

const reply = (result: ToolResult<unknown>) =>
  result.ok
    ? { content: [{ type: "text" as const, text: JSON.stringify(result.value) }] }
    : { content: [{ type: "text" as const, text: result.error }], isError: true };

/**
 * The tools a PM token carries, and nothing else. A tool added to the
 * person's server stays off the PM's until it is listed here.
 */
export const PM_TOOLS = [
  "list_boards",
  "list_cards",
  "get_card",
  "get_colony",
  "card_status",
  "create_backlog_card",
  "create_epic",
  "move_card",
  "update_card",
  "comment_card",
  "rerun_checks",
  "update_branch_from_base",
  "open_pull_request",
  "answer_card_question",
  "add_dependency",
  "close_card",
  "merge_pull_request",
  "add_follow_up",
  "propose_card",
] as const;

const wrongBoard = () => reply({ ok: false, error: WRONG_BOARD });

/** Once a minute per board is plenty: a mark lifted stays lifted. */
const PM_PROOF_EVERY_MS = 60_000;
const pmProven = new Map<string, number>();

async function pmWorking(projectId: string): Promise<void> {
  const now = Date.now();
  if (now - (pmProven.get(projectId) ?? 0) < PM_PROOF_EVERY_MS) return;
  pmProven.set(projectId, now);
  await workedOn(projectId, await repository().assistantAgent(projectId).catch(() => null));
}

/**
 * A server for one request, whose tools act as one person: read-only when
 * their token is. A PM token's `scope` limits it to its one board and the
 * PM_TOOLS, and puts closing, merging and optional cards to the person.
 */
export function mcpServerFor(user: UserRecord, readOnly: boolean, scope: TokenScope | null = null): McpServer {
  const caller = { user, readOnly };
  const server = new McpServer({ name: "formic", version: "1.0.0" });
  if (scope) only(server, new Set(PM_TOOLS));
  const readHint = { readOnlyHint: true };
  // Every tool names its board; a PM token refuses any other before a tool runs.
  const onBoard = <I extends { board: string }>(handle: (input: I) => Promise<ReturnType<typeof reply>>) =>
    async (input: I) => {
      if (scope && input.board !== scope.projectId) return wrongBoard();
      // A PM calling a tool is a PM whose model is answering: its account has
      // usage, so a stale mark must not hold back a card it restarts.
      if (scope) await pmWorking(scope.projectId);
      return handle(input);
    };
  server.registerTool(
    "list_boards",
    { description: scope ? "The board this session works on." : "The boards you can see.", annotations: readHint },
    async () => {
      const boards = await listBoards(user);
      return reply({ ok: true, value: scope ? boards.filter((b) => b.id === scope.projectId) : boards });
    },
  );
  server.registerTool(
    "list_cards",
    {
      description: "The cards on a board, optionally only those in one column.",
      inputSchema: { board: z.string(), column: z.enum(COLUMNS).optional() },
      annotations: readHint,
    },
    onBoard(async (input) => reply(await listCards(user, input))),
  );
  server.registerTool(
    "get_card",
    {
      description: "One card: an Epic with its PRD, or a ticket with its description and acceptance criteria.",
      inputSchema: { board: z.string(), card: z.string() },
      annotations: readHint,
    },
    onBoard(async (input) => reply(await getCard(user, input))),
  );
  server.registerTool(
    "get_colony",
    {
      description: "A board's colony level and XP progress within the level.",
      inputSchema: { board: z.string() },
      annotations: readHint,
    },
    onBoard(async (input) => reply(await getColony(user, input))),
  );
  server.registerTool(
    "create_backlog_card",
    {
      description: "Adds a request to the board's Backlog, as the UI's New card does.",
      inputSchema: { board: z.string(), rawRequest: z.string().trim().min(3).max(MAX_REQUEST) },
    },
    onBoard(async (input) => {
      const gated = scope && (await gateOptional({ user, scope }, input.board, [input.rawRequest]));
      return reply(gated || (await createBacklogCard(caller, input)));
    }),
  );
  server.registerTool(
    "create_epic",
    {
      description: "Adds an Epic with its tickets, already broken down. It lands in To Do with them, ready to run. Tickets name their dependencies by the key given here.",
      inputSchema: {
        board: z.string(),
        title: z.string().trim().min(1).max(120),
        rawRequest: z.string().trim().min(1).max(MAX_REQUEST),
        tickets: z
          .array(
            z.object({
              key: z.string().min(1),
              title: z.string().trim().min(1),
              description: z.string(),
              acceptanceCriteria: z.array(z.string()),
              fileScope: z.array(z.string()).optional(),
              storyPoints: z.number().nullable().optional(),
              dependsOn: z.array(z.string()).optional(),
            }),
          )
          .min(1),
      },
    },
    onBoard(async (input) => {
      const gated = scope && (await gateOptional({ user, scope }, input.board, [input.title, ...input.tickets.map((t) => t.title)]));
      if (gated) return reply(gated);
      // An Epic lands in To Do ready to run: a start, which a wake-up makes once.
      if (scope && !(await mayStartWork({ user, scope }, input.board, ""))) return reply({ ok: false, error: ONE_START });
      return reply(await createEpic(caller, input));
    }),
  );
  server.registerTool(
    "move_card",
    {
      description: "Moves a card to a column as dragging it would, and says why when the board refuses.",
      inputSchema: { board: z.string(), card: z.string(), to: z.enum(COLUMNS) },
    },
    onBoard(async (input) => {
      // Done is a merge for a ticket: a PM asks the person.
      if (scope && input.to === "done") return reply(await proposeDone({ user, scope }, input));
      // A wake-up starts agent work once; a second move into a working column is put to the person.
      const gated = scope && (await gateMove({ user, scope }, input));
      return reply(gated || (await moveCard(caller, input)));
    }),
  );
  server.registerTool(
    "update_card",
    {
      description: "Edits a ticket's title, description, acceptance criteria, file scope or story points, or an Epic's PRD.",
      inputSchema: {
        board: z.string(),
        card: z.string(),
        title: z.string().trim().min(1).optional(),
        description: z.string().optional(),
        acceptanceCriteria: z.array(z.string()).optional(),
        fileScope: z.array(z.string()).optional(),
        storyPoints: z.number().nullable().optional(),
        prd: prdSchema.optional(),
      },
    },
    onBoard(async ({ board, card, ...edit }) => reply(await updateCard(caller, { board, card, edit }))),
  );
  server.registerTool(
    "comment_card",
    {
      description: "Writes a message in a card's chat as you. No agent answers it.",
      inputSchema: { board: z.string(), card: z.string(), text: z.string().trim().min(1).max(4000) },
    },
    onBoard(async (input) => reply(await commentCard(caller, input))),
  );
  if (scope) registerPmTools(server, { user, scope });
  return server;
}
/** Makes `server` drop any tool registered on it that `allowed` does not name. */
function only(server: McpServer, allowed: ReadonlySet<string>): void {
  const register = server.registerTool.bind(server) as (...args: unknown[]) => RegisteredTool;
  server.registerTool = ((name: string, ...rest: unknown[]) => {
    const tool = register(name, ...rest);
    if (!allowed.has(name)) tool.remove();
    return tool;
  }) as typeof server.registerTool;
}

const cardInput = { board: z.string(), card: z.string().describe("The card's key, as the board shows it, or its id.") };

/** The PM's own tools: its live lookups, its direct actions, and the gated ones that only propose. */
function registerPmTools(server: McpServer, pm: PmCaller): void {
  const readHint = { readOnlyHint: true };
  const asks = "It never acts: it posts a proposal in the board chat, and the person approves or dismisses it.";
  server.registerTool(
    "card_status",
    {
      description: "One card as it is right now: column, why it is there, agent runs, pull request, checks and a red check's log.",
      inputSchema: cardInput,
      annotations: readHint,
    },
    async (input) => reply(await cardStatus(pm, input)),
  );
  server.registerTool(
    "rerun_checks",
    { description: "Runs a ticket's failed GitHub Actions checks again, for a failure that is not the code's.", inputSchema: cardInput },
    async (input) => reply(await rerunChecks(pm, input)),
  );
  server.registerTool(
    "update_branch_from_base",
    { description: "Brings the base branch into a ticket's pull request with a merge commit, as GitHub's Update branch does.", inputSchema: cardInput },
    async (input) => reply(await updateBranch(pm, input)),
  );
  server.registerTool(
    "open_pull_request",
    {
      description:
        "Opens a pull request into the base branch for a branch already pushed to the board's repository: one under formic-pm/ or a ticket's branch. A branch that changes .github/workflows/ is refused.",
      inputSchema: {
        board: z.string(),
        branch: z.string().trim().min(1),
        title: z.string().trim().min(1).max(120),
        body: z.string().trim().min(1).max(20_000),
        unblocks: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "The key of a blocked ticket this pull request fixes, when it does. That card then waits on this pull request and updates from main by itself once it merges.",
          ),
      },
    },
    async (input) => reply(await openPullRequest(pm, input)),
  );
  server.registerTool(
    "answer_card_question",
    {
      description:
        "Answers the question a card's agent is waiting on, and its agent starts again. Set own when the answer is yours rather than the person's words.",
      inputSchema: { ...cardInput, answer: z.string().trim().min(1).max(8_000), own: z.boolean().default(false) },
    },
    async (input) => reply(await answerQuestion(pm, input)),
  );
  server.registerTool(
    "add_dependency",
    {
      description: "Makes a ticket wait for another ticket on the board to merge first.",
      inputSchema: { ...cardInput, dependsOn: z.string().describe("The key of the ticket it waits for.") },
    },
    async (input) => reply(await addCardDependency(pm, input)),
  );
  server.registerTool(
    "close_card",
    {
      description: `Asks the person to close a card: archive a ticket, or archive an Epic with its tickets. ${asks}`,
      inputSchema: { ...cardInput, reason: z.string().trim().min(1).max(500) },
    },
    async (input) => reply(await closeCard(pm, input)),
  );
  server.registerTool(
    "merge_pull_request",
    { description: `Asks the person to merge a ticket's pull request. ${asks}`, inputSchema: cardInput },
    async (input) => reply(await mergePullRequest(pm, input)),
  );
  server.registerTool(
    "add_follow_up",
    {
      description: `Asks the person to add a follow-up a ticket's agent suggested. ${asks}`,
      inputSchema: { board: z.string(), ticket: z.string(), title: z.string().trim().min(1) },
    },
    async (input) => reply(await addFollowUp(pm, input)),
  );
  server.registerTool(
    "propose_card",
    {
      description: `Asks the person to add a card they did not ask for: a nice-to-have or an idea of yours. ${asks}`,
      inputSchema: {
        board: z.string(),
        request: z.string().trim().min(3).max(MAX_REQUEST),
        column: z.enum(["backlog", "todo"]).default("backlog"),
        why: z.string().trim().min(1).max(500),
      },
    },
    async (input) => reply(await proposeCard(pm, input)),
  );
}
